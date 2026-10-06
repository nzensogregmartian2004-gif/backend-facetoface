import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { MOBILE_OPERATORS, payments, type MobileOperator } from '../../utils/payments';
import type { SettleOutcome, SettleResult } from '../payments/settlement';
import { lockUser } from './calls.lock';
import { publishRealtime } from '../../realtime/realtime';

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as object));

/**
 * SEUL point de passage du paiement d'un appel vers PAID / FAILED (webhook, rapprochement). Même principe que `settlePurchase` :
 * idempotent, chaque transition est un `updateMany` gardé par le statut courant.
 *  - SUCCESS : PAID si le montant confirmé est ≥ au prix ; l'appel passe alors en RINGING (le créateur est appelé).
 *    Mais un paiement confirmé trop tard (> CALL_PAYMENT_VALID_SECONDS, ou appel déjà abandonné) ou un créateur devenu occupé
 *    ne font PAS sonner : l'appel est clos « manqué » et le remboursement est DÛ (exécuté à l'étape 13). L'argent n'est jamais gardé sans service rendu.
 *  - SUCCESS sur un paiement déjà FAILED : de l'argent a été pris alors qu'on croyait à un échec → REVIEW (LATE_SUCCESS), jamais ignoré.
 *  - FAILED : l'appel est abandonné (PAYMENT_FAILED), aucun service rendu.
 */
export async function settleCallPayment(reference: string, o: SettleOutcome): Promise<SettleResult> {
  const result = await prisma.$transaction(async (tx) => {
    const c = await tx.call.findUnique({ where: { reference } });
    if (!c) return 'unknown';
    if (c.paymentStatus === 'PAID') return 'already';
    const payload = json(o.payload);

    if (o.status === 'SUCCESS') {
      if (c.paymentStatus === 'FAILED') {
        await tx.call.updateMany({ where: { id: c.id, paymentStatus: 'FAILED' }, data: { paymentStatus: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } });
        console.error(`[paiement] succès tardif sur un appel échoué (réf ${reference}) : vérification manuelle / remboursement requis`);
        return 'review';
      }
      if (o.amountFcfa !== undefined && o.amountFcfa < c.grossFcfa) {
        await tx.call.updateMany({ where: { id: c.id, paymentStatus: { in: ['PENDING', 'REVIEW'] } }, data: { paymentStatus: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', status: 'PAYMENT_FAILED', providerPayload: payload } });
        console.error(`[paiement] montant confirmé (${o.amountFcfa}) inférieur au prix (${c.grossFcfa}) pour l'appel de réf ${reference} : vérification manuelle`);
        return 'review';
      }
      await lockUser(tx, c.calleeId); // sérialise les paiements simultanés vers un même créateur
      const now = new Date();
      const stale = c.status !== 'AWAITING_PAYMENT' || now.getTime() - c.initiatedAt.getTime() > env.CALL_PAYMENT_VALID_SECONDS * 1000;
      const busy = !stale && (await tx.call.count({ where: { id: { not: c.id }, status: { in: ['RINGING', 'ACTIVE'] }, OR: [{ calleeId: c.calleeId }, { callerId: c.calleeId }] } })) > 0;
      const paid = { paymentStatus: 'PAID' as const, paidAt: now, reviewReason: null, providerPayload: payload, ...(o.providerRef ? { externalRef: o.providerRef } : {}) };
      const next = stale || busy
        ? { status: 'MISSED' as const, endReason: stale ? ('STALE_PAYMENT' as const) : ('CREATOR_BUSY' as const), endedAt: now, consumedFcfa: 0, commissionFcfa: 0, creatorFcfa: 0, refundFcfa: c.grossFcfa, refundStatus: 'DUE' as const }
        : { status: 'RINGING' as const, ringExpiresAt: new Date(now.getTime() + env.CALL_RING_SECONDS * 1000) };
      const r = await tx.call.updateMany({ where: { id: c.id, paymentStatus: { in: ['PENDING', 'REVIEW'] } }, data: { ...paid, ...next } });
      return r.count === 1 ? 'paid' : 'already';
    }

    if (c.paymentStatus === 'FAILED') return 'already';
    const r = await tx.call.updateMany({ where: { id: c.id, paymentStatus: { in: ['PENDING', 'REVIEW'] } }, data: { paymentStatus: 'FAILED', status: 'PAYMENT_FAILED', reviewReason: null, providerPayload: payload } });
    return r.count === 1 ? 'failed' : 'already';
  });
  return result;
}

/**
 * Rapprochement des paiements d'appel restés PENDING (webhook perdu) — même règle que `reconcilePurchases` :
 * interrogation du prestataire après PAYMENT_STATUS_CHECK_AFTER_SECONDS ; sans réponse après PAYMENT_REVIEW_AFTER_SECONDS → REVIEW.
 * JAMAIS d'échec automatique (le client a pu être débité). L'appel est alors abandonné (PAYMENT_FAILED) : un succès tardif ne le fera pas sonner mais sera remboursable.
 */
export async function reconcileCallPayments(now = new Date()) {
  const checkBefore = new Date(now.getTime() - env.PAYMENT_STATUS_CHECK_AFTER_SECONDS * 1000);
  const reviewBefore = new Date(now.getTime() - env.PAYMENT_REVIEW_AFTER_SECONDS * 1000);
  const rows = await prisma.call.findMany({
    where: { reference: { not: null }, initiatedAt: { lt: checkBefore }, OR: [{ paymentStatus: 'PENDING' }, { paymentStatus: 'REVIEW', reviewReason: 'TIMEOUT' }] },
    orderBy: { initiatedAt: 'asc' }, take: 50,
  });
  const out = { checked: 0, paid: 0, failed: 0, review: 0, unknown: 0 };
  for (const c of rows) {
    out.checked++;
    const op = MOBILE_OPERATORS.find((x) => x === c.operator) as MobileOperator | undefined;
    let remote: Awaited<ReturnType<typeof payments.checkStatus>> = null;
    try { if (op) remote = await payments.checkStatus(c.reference!, op); } catch { remote = null; }
    if (remote === 'SUCCESS' || remote === 'FAILED') {
      const r = await settleCallPayment(c.reference!, { status: remote });
      if (r === 'paid') out.paid++; else if (r === 'failed') out.failed++; else if (r === 'review') out.review++;
      continue;
    }
    out.unknown++;
    if (c.paymentStatus === 'PENDING' && c.initiatedAt < reviewBefore) {
      const r = await prisma.call.updateMany({ where: { id: c.id, paymentStatus: 'PENDING' }, data: { paymentStatus: 'REVIEW', reviewReason: 'TIMEOUT', status: 'PAYMENT_FAILED' } });
      if (r.count === 1) { out.review++; console.error(`[paiement] aucune confirmation pour l'appel de réf ${c.reference} après ${env.PAYMENT_REVIEW_AFTER_SECONDS}s : vérification manuelle`); }
    }
  }
  return out;
}
