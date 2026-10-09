import { Prisma, type User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { splitRecord } from '../../utils/money';
import { assertMobileMoneyCurrency, DEFAULT_CURRENCY } from '../../utils/currency';
import { payments, type MobileOperator } from '../../utils/payments';
import { getConfigValue } from '../config/config.service';
import { recordCreatorEarning } from '../monetization/monetization.service';
import { notify } from '../notifications/notifications.service';
import { groupDto, MAX_MEMBERS } from './groups.service';
import type { SettleOutcome, SettleResult } from '../payments/settlement';

const newReference = () => `G${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();
const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as object));
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Invitation encore utilisable : non révoquée, non expirée, places restantes. */
const validInvite = (i: { revokedAt: Date | null; expiresAt: Date | null; maxUses: number | null; uses: number }) =>
  !i.revokedAt && !(i.expiresAt && i.expiresAt <= new Date()) && !(i.maxUses != null && i.uses >= i.maxUses);

/** Commission plateforme sur l'accès aux groupes : administrable (AppConfig), figée à chaque achat. */
export async function groupAccessCommissionBps(): Promise<number> {
  const v = await getConfigValue<number>('GROUP_ACCESS.COMMISSION_BPS', 2000);
  return typeof v === 'number' && v >= 0 && v <= 10_000 ? v : 2000;
}

/** Ajoute le membre si le groupe peut le recevoir ; false sinon (groupe complet, invitation révoquée ou épuisée). */
async function grantMembership(tx: Prisma.TransactionClient, conversationId: string, userId: string, inviteId: string | null): Promise<boolean> {
  const existing = await tx.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { id: true } });
  if (existing) return true;
  if ((await tx.conversationMember.count({ where: { conversationId } })) >= MAX_MEMBERS) return false;
  const invite = inviteId ? await tx.conversationInvite.findUnique({ where: { id: inviteId } }) : null;
  if (!invite || !validInvite(invite)) return false;
  await tx.conversationMember.create({ data: { conversationId, userId, role: 'MEMBER' } });
  await tx.conversationInvite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
  return true;
}

const purchaseView = (p: { id: string; status: string; operator: string | null; grossAmount: number; currency: string; initiatedAt: Date }) =>
  ({ id: p.id, status: p.status, operator: p.operator, price: p.grossAmount, currency: p.currency, initiatedAt: p.initiatedAt, review: p.status === 'REVIEW' });

async function groupFor(viewer: User, conversationId: string) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { members: { include: { user: true } } } });
  return groupDto(viewer, conv);
}

/**
 * Paiement d'entrée dans un groupe payant (Mobile Money, asynchrone) :
 *  - 200 `{ status: 'PAID', group }` si déjà membre, ou déjà payé (accès rétabli sans nouveau débit) ;
 *  - 202 `{ status: 'PENDING', purchase }` : demande envoyée, le client valide sur son téléphone ; le résultat arrive par webhook ;
 *  - 402 refus net (aucun débit) ; 409 paiement déjà en cours ou à vérifier ; 503 paiements non configurés.
 * Aucun débit n'est demandé pour une place qui ne peut pas être accordée (groupe complet, invitation épuisée).
 */
export async function payGroupAccess(viewer: User, token: string, input: { operator: MobileOperator; phone: string }) {
  const invite = await prisma.conversationInvite.findUnique({ where: { token }, include: { conversation: true } });
  if (!invite || !invite.conversation.isGroup || !validInvite(invite)) throw notFound('Invitation invalide ou expirée');
  const conv = invite.conversation;
  if (conv.entryPrice == null) throw badRequest('GROUP_NOT_PAID', "Ce groupe n'est pas payant : rejoignez-le directement");

  const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: conv.id, userId: viewer.id } }, select: { id: true } });
  const existing = await prisma.groupAccessPurchase.findUnique({ where: { conversationId_buyerId: { conversationId: conv.id, buyerId: viewer.id } } });
  if (member || existing?.status === 'PAID') {
    const granted = await prisma.$transaction((tx) => grantMembership(tx, conv.id, viewer.id, invite.id));
    if (!granted) throw conflict('GROUP_FULL', 'Le groupe est complet ou l’invitation n’est plus valable');
    return { httpStatus: 200 as const, status: 'PAID' as const, group: await groupFor(viewer, conv.id) };
  }
  if (existing?.status === 'PENDING') throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce groupe', { purchaseId: existing.id });
  if (existing?.status === 'REVIEW') throw conflict('PAYMENT_UNDER_REVIEW', 'Votre paiement est en cours de vérification : ne le renouvelez pas, vous serez notifié', { purchaseId: existing.id });
  if (!payments.operators().includes(input.operator)) {
    if (payments.operators().length === 0) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible", { operator: 'Opérateur indisponible' });
  }
  const count = await prisma.conversationMember.count({ where: { conversationId: conv.id } });
  if (count >= MAX_MEMBERS) throw conflict('GROUP_FULL', 'Le groupe est complet');
  if (!conv.ownerId) throw conflict('GROUP_NO_OWNER', 'Ce groupe n’a pas de propriétaire pour recevoir le paiement');

  const currency = conv.entryCurrency ?? DEFAULT_CURRENCY;
  assertMobileMoneyCurrency(currency);
  const split = splitRecord(conv.entryPrice, await groupAccessCommissionBps(), currency);
  const reference = newReference();
  const attempt = { reference, operator: input.operator, payerPhoneHint: input.phone.slice(-4), initiatedAt: new Date(), reviewReason: null, providerPayload: undefined, inviteId: invite.id, sellerId: conv.ownerId };
  let purchaseId: string;
  if (existing) { // échec définitif précédent : une seule requête peut reprendre la ligne, avec une nouvelle référence
    const claimed = await prisma.groupAccessPurchase.updateMany({ where: { id: existing.id, status: 'FAILED' }, data: { status: 'PENDING', attempts: { increment: 1 }, externalRef: null, paidAt: null, ...split, ...attempt, providerPayload: Prisma.DbNull } });
    if (claimed.count !== 1) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce groupe');
    purchaseId = existing.id;
  } else {
    try {
      purchaseId = (await prisma.groupAccessPurchase.create({ data: { conversationId: conv.id, buyerId: viewer.id, ...split, ...attempt } })).id;
    } catch (e) {
      if (isUnique(e)) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce groupe');
      throw e;
    }
  }

  const fail = () => prisma.groupAccessPurchase.updateMany({ where: { id: purchaseId, status: 'PENDING' }, data: { status: 'FAILED' } });
  let res;
  try {
    res = await payments.initiate({ reference, amount: split.grossAmount, currency, operator: input.operator, phone: input.phone, description: 'Accès au groupe' });
  } catch (e) { // rien n'est parti chez le prestataire : échec définitif, nouvel essai possible
    await fail();
    throw e;
  }
  if (res.status === 'REJECTED') {
    await fail();
    throw new AppError(402, 'PAYMENT_FAILED', res.message || 'Le paiement a été refusé', { code: res.code });
  }
  if (res.status === 'ACCEPTED' && res.providerRef) await prisma.groupAccessPurchase.updateMany({ where: { id: purchaseId, status: 'PENDING' }, data: { externalRef: res.providerRef } });
  const now = await prisma.groupAccessPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  if (now.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, group: await groupFor(viewer, conv.id) };
  return { httpStatus: 202 as const, status: 'PENDING' as const, purchase: purchaseView(now) };
}

/** État d'un achat d'accès pour son acheteur. Une fois PAID, renvoie le groupe. */
export async function getGroupAccessPurchase(viewer: User, purchaseId: string) {
  const p = await prisma.groupAccessPurchase.findUnique({ where: { id: purchaseId } });
  if (!p || p.buyerId !== viewer.id) throw notFound('Achat introuvable');
  return { purchase: purchaseView(p), ...(p.status === 'PAID' ? { group: await groupFor(viewer, p.conversationId) } : {}) };
}

/**
 * Règlement d'un achat d'accès (webhook ou rapprochement). Même garantie que les messages payants : une seule transition,
 * jamais de double crédit, montant insuffisant ou succès tardif → vérification manuelle. L'accès n'est accordé qu'ici.
 */
export async function settleGroupAccess(reference: string, o: SettleOutcome): Promise<SettleResult> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.groupAccessPurchase.findUnique({ where: { reference } });
    if (!p) return 'unknown';
    if (p.status === 'PAID') return 'already';
    const payload = json(o.payload);

    if (o.status === 'SUCCESS') {
      if (p.status === 'FAILED') {
        await tx.groupAccessPurchase.updateMany({ where: { id: p.id, status: 'FAILED' }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } });
        console.error(`[groupes] succès tardif sur un accès échoué (réf ${reference}) : vérification manuelle / remboursement requis`);
        return 'review';
      }
      if (o.amount !== undefined && o.amount < p.grossAmount) {
        await tx.groupAccessPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } });
        console.error(`[groupes] montant confirmé (${o.amount}) inférieur au prix (${p.grossAmount}) pour la réf ${reference} : vérification manuelle`);
        return 'review';
      }
      const granted = await grantMembership(tx, p.conversationId, p.buyerId, p.inviteId);
      if (!granted) { // argent reçu mais place impossible à accorder : pas de passage à « payé », vérification manuelle (remboursement)
        await tx.groupAccessPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'REVIEW', reviewReason: 'ACCESS_NOT_GRANTABLE', providerPayload: payload } });
        console.error(`[groupes] accès non accordable (réf ${reference}) : groupe complet ou invitation révoquée, vérification manuelle`);
        return 'review';
      }
      const r = await tx.groupAccessPurchase.updateMany({
        where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } },
        data: { status: 'PAID', paidAt: new Date(), reviewReason: null, method: p.operator ?? 'mobile_money', ...(o.providerRef ? { externalRef: o.providerRef } : {}), providerPayload: payload },
      });
      if (r.count !== 1) return 'already';
      await recordCreatorEarning(tx, { creatorId: p.sellerId, source: 'GROUP_ACCESS', sourceId: p.id, grossAmount: p.grossAmount, currency: p.currency, commissionBps: p.commissionBps, status: 'AVAILABLE' });
      await notify(tx, { userId: p.sellerId, type: 'GROUP_ACCESS_PURCHASED', actorId: p.buyerId, targetType: 'CONVERSATION', targetId: p.conversationId, amount: p.creatorAmount, currency: p.currency });
      return 'paid';
    }

    if (p.status === 'FAILED') return 'already';
    const r = await tx.groupAccessPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'FAILED', reviewReason: null, providerPayload: payload } });
    return r.count === 1 ? 'failed' : 'already';
  });
}

/** Revenus du groupe pour son propriétaire : accès vendus, brut, commission, net. Réservé au propriétaire. */
export async function groupAccessSummary(viewer: User, conversationId: string) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { isGroup: true, ownerId: true, entryPrice: true, entryCurrency: true } });
  if (!conv?.isGroup) throw notFound('Groupe introuvable');
  const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: viewer.id } }, select: { id: true } });
  if (!member) throw notFound('Groupe introuvable');
  if (conv.ownerId !== viewer.id) throw forbidden('GROUP_OWNER_REQUIRED', 'Réservé au propriétaire du groupe');
  const sums = await prisma.groupAccessPurchase.aggregate({ where: { conversationId, sellerId: viewer.id, status: 'PAID' }, _count: { _all: true }, _sum: { grossAmount: true, commissionAmount: true, creatorAmount: true } });
  const pending = await prisma.groupAccessPurchase.count({ where: { conversationId, sellerId: viewer.id, status: { in: ['PENDING', 'REVIEW'] } } });
  const currency = conv.entryCurrency ?? DEFAULT_CURRENCY;
  return {
    entry: conv.entryPrice != null ? { price: conv.entryPrice, currency } : null,
    commissionBps: await groupAccessCommissionBps(),
    totals: { buyers: sums._count._all, gross: sums._sum.grossAmount ?? 0, commission: sums._sum.commissionAmount ?? 0, net: sums._sum.creatorAmount ?? 0, currency },
    pending,
  };
}
