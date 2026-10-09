import { prisma } from '../../config/db';
import { settleCallPayment } from '../calls/calls.settlement';
import { settleGroupAccess } from '../messages/groupAccess.service';
import { notify } from '../notifications/notifications.service';
import { recordPaidMessageEarning } from '../monetization/monetization.service';
import { settleSubscriptionPayment } from '../subscriptions/subscriptions.service';
import { settleCustomVideoPayment } from '../customVideos/customVideos.service';
import { settlePremiumPayment } from '../premium/premium.service';
import { syncPaymentTransaction } from '../wallet/wallet.service';
import { settleCoinPurchase } from '../coins/coins.service';
import { assessActivity, holdPaymentReference } from '../fraud/fraud.service';

export type SettleOutcome = { status: 'SUCCESS' | 'FAILED'; /** Montant confirmé par le prestataire, s'il l'indique. */ amount?: number; providerRef?: string; payload?: unknown };
export type SettleResult = 'paid' | 'failed' | 'review' | 'already' | 'unknown';

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as object));

/**
 * SEUL point de passage d'un achat de PENDING/REVIEW vers PAID/FAILED (webhook, rapprochement). Idempotent et sûr en cas de course :
 * chaque transition est un `updateMany` gardé par le statut courant, et la notification du créateur part dans la même transaction.
 *  - SUCCESS sur PENDING/REVIEW : PAID si le montant confirmé est ≥ au prix (frais éventuels inclus), sinon REVIEW (AMOUNT_MISMATCH) ;
 *  - FAILED  sur PENDING/REVIEW : FAILED (nouvel essai possible) ;
 *  - SUCCESS sur un achat déjà FAILED : de l'argent a été pris alors qu'on croyait à un échec → REVIEW (LATE_SUCCESS), jamais ignoré.
 */
export async function settlePurchase(reference: string, o: SettleOutcome): Promise<SettleResult> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.messagePurchase.findUnique({ where: { reference } });
    if (!p) return 'unknown';
    if (p.status === 'PAID') return 'already';
    const payload = json(o.payload);

    if (o.status === 'SUCCESS') {
      if (p.status === 'FAILED') {
        await tx.messagePurchase.updateMany({ where: { id: p.id, status: 'FAILED' }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } });
        console.error(`[paiement] succès tardif sur un achat échoué (réf ${reference}) : vérification manuelle / remboursement requis`);
        return 'review';
      }
      if (o.amount !== undefined && o.amount < p.grossAmount) {
        await tx.messagePurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } });
        console.error(`[paiement] montant confirmé (${o.amount}) inférieur au prix (${p.grossAmount}) pour la réf ${reference} : vérification manuelle`);
        return 'review';
      }
      const r = await tx.messagePurchase.updateMany({
        where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } },
        data: { status: 'PAID', paidAt: new Date(), reviewReason: null, method: p.operator ?? 'mobile_money', ...(o.providerRef ? { externalRef: o.providerRef } : {}), providerPayload: payload },
      });
      if (r.count !== 1) return 'already';
      const m = await tx.message.findUnique({ where: { id: p.messageId }, select: { conversationId: true } });
      await recordPaidMessageEarning(tx, p);
      await notify(tx, { userId: p.sellerId, type: 'MESSAGE_PURCHASED', actorId: p.buyerId, targetType: 'CONVERSATION', targetId: m?.conversationId, amount: p.creatorAmount, currency: p.currency });
      return 'paid';
    }

    if (p.status === 'FAILED') return 'already';
    const r = await tx.messagePurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'FAILED', reviewReason: null, providerPayload: payload } });
    return r.count === 1 ? 'failed' : 'already';
  });
}

/**
 * Point d'entrée UNIQUE des webhooks et du rapprochement : aiguille la référence marchand vers le bon règlement.
 * Préfixe `C` = appel payant (`settleCallPayment`), sinon achat de message (`settlePurchase`). Les deux restent le SEUL chemin vers PAID / FAILED.
 */
export async function settleReference(reference: string, o: SettleOutcome): Promise<SettleResult> {
  if (o.status === 'SUCCESS') {
    const actor = reference.startsWith('C')
      ? await prisma.call.findUnique({ where: { reference }, select: { callerId: true } })
      : reference.startsWith('S')
        ? await prisma.creatorSubscriptionPayment.findUnique({ where: { reference }, select: { buyerId: true } })
        : reference.startsWith('V')
          ? await prisma.customVideoPayment.findUnique({ where: { reference }, select: { buyerId: true } })
          : reference.startsWith('P')
            ? await prisma.premiumPayment.findUnique({ where: { reference }, select: { userId: true } })
            : reference.startsWith('K')
              ? await prisma.coinPurchase.findUnique({ where: { reference }, select: { userId: true } })
              : reference.startsWith('G')
                ? await prisma.groupAccessPurchase.findUnique({ where: { reference }, select: { buyerId: true } })
                : await prisma.messagePurchase.findUnique({ where: { reference }, select: { buyerId: true } });
    const userId = actor && ('callerId' in actor ? actor.callerId : 'buyerId' in actor ? actor.buyerId : actor.userId);
    if (userId) {
      const risk = await assessActivity(userId, 'PAYMENT', {});
      if (risk.decision !== 'ALLOW') { await holdPaymentReference(reference, risk.reason); await syncPaymentTransaction(reference, 'REVIEW', o.providerRef); return 'review'; }
    }
  }
  let result: SettleResult;
  if (reference.startsWith('C')) result = await settleCallPayment(reference, o);
  else if (reference.startsWith('S')) result = await settleSubscriptionPayment(reference, o);
  else if (reference.startsWith('V')) result = await settleCustomVideoPayment(reference, o);
  else if (reference.startsWith('P')) result = await settlePremiumPayment(reference, o);
  else if (reference.startsWith('K')) result = await settleCoinPurchase(reference, o);
  else if (reference.startsWith('G')) result = await settleGroupAccess(reference, o);
  else result = await settlePurchase(reference, o);
  if (result !== 'unknown') {
    const status = result === 'paid' || result === 'already' ? 'PAID' : result === 'failed' ? 'FAILED' : 'REVIEW';
    await syncPaymentTransaction(reference, status, o.providerRef);
  }
  return result;
}
