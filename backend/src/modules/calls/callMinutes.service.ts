import { randomBytes } from 'crypto';
import type { CallMinutePurchase, CallType, Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { payments, type MobileOperator } from '../../utils/payments';
import { assertMobileMoneyCurrency } from '../../utils/currency';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { OFFER_MAX_SECONDS, OFFER_MIN_SECONDS, OFFERS_MAX_PER_KIND } from './callMinutes.schemas';

const db = prisma;
/** Référence marchand de l'achat de minutes : préfixe N, 13 caractères au plus. */
const ref = () => `N${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();

/** Montant d'une durée : prix de la minute × secondes / 60, arrondi au franc le plus proche. */
export function minuteAmount(pricePerMinute: number, seconds: number): number {
  return Math.round((pricePerMinute * seconds) / 60);
}

/** Tarif à la minute du créateur pour un type d'appel. Refus explicite si absent. */
export async function creatorRate(creatorId: string, kind: CallType) {
  const s = await db.creatorCallSettings.findUnique({ where: { userId: creatorId } });
  if (!s) throw notFound('Ce créateur ne vend pas de minutes d’appel');
  if (s.pricingMode !== 'PER_MINUTE') throw badRequest('CALL_RATE_NOT_PER_MINUTE', 'Ce créateur n’a pas de tarif à la minute');
  const rate = kind === 'AUDIO' ? s.audioPrice : s.videoPrice;
  if (!rate || rate < 1) throw badRequest('CALL_KIND_NOT_PRICED', 'Tarif non défini pour ce type d’appel');
  return { rate, currency: s.currency };
}

const view = (p: Pick<CallMinutePurchase, 'id' | 'status' | 'seconds' | 'grossAmount' | 'currency' | 'operator' | 'initiatedAt' | 'paidAt' | 'reviewReason'>) => ({
  id: p.id, status: p.status, seconds: p.seconds, grossAmount: p.grossAmount, currency: p.currency, operator: p.operator,
  initiatedAt: p.initiatedAt, paidAt: p.paidAt, review: p.status === 'REVIEW',
});

/** Durées vendues par un créateur, avec leur prix calculé. Sans tarif : liste vide et prix null. */
export async function offersFor(creatorId: string, kind: CallType) {
  const rows = await db.callMinuteOffer.findMany({
    where: { creatorId, kind, active: true },
    orderBy: [{ sortOrder: 'asc' }, { seconds: 'asc' }],
  });
  const priced = await creatorRate(creatorId, kind).catch(() => null);
  return {
    kind,
    pricePerMinute: priced?.rate ?? null,
    currency: priced?.currency ?? null,
    offers: priced ? rows.map((o) => ({ id: o.id, seconds: o.seconds, amount: minuteAmount(priced.rate, o.seconds) })) : [],
  };
}

/** Le créateur remplace ses durées pour un type d'appel. Il faut un tarif à la minute avant de vendre des durées. */
export async function setOffers(creator: User, input: { kind: CallType; offers: { seconds: number }[] }) {
  if (!creator.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur pour vendre des minutes');
  const seconds = input.offers.map((o) => o.seconds);
  if (new Set(seconds).size !== seconds.length) throw badRequest('OFFER_DUPLICATE', 'Une même durée est proposée deux fois');
  if (seconds.length > OFFERS_MAX_PER_KIND) throw badRequest('OFFERS_TOO_MANY', `Au plus ${OFFERS_MAX_PER_KIND} durées`);
  for (const s of seconds) {
    if (s < OFFER_MIN_SECONDS || s > OFFER_MAX_SECONDS) throw badRequest('OFFER_DURATION_INVALID', 'Durée hors limites');
  }
  await creatorRate(creator.id, input.kind);
  await db.$transaction(async (tx) => {
    for (const [i, s] of seconds.entries()) {
      await tx.callMinuteOffer.upsert({
        where: { creatorId_kind_seconds: { creatorId: creator.id, kind: input.kind, seconds: s } },
        create: { creatorId: creator.id, kind: input.kind, seconds: s, sortOrder: i, active: true },
        update: { sortOrder: i, active: true },
      });
    }
    // Les durées retirées restent en base (des achats peuvent les référencer) : elles deviennent inactives.
    await tx.callMinuteOffer.updateMany({
      where: { creatorId: creator.id, kind: input.kind, seconds: { notIn: seconds } },
      data: { active: false },
    });
  });
  return offersFor(creator.id, input.kind);
}

/** Soldes de minutes du client, par créateur et par type d'appel. */
export async function myAccounts(user: User) {
  const rows = await db.callMinuteAccount.findMany({
    where: { userId: user.id, balanceSeconds: { gt: 0 } },
    include: { creator: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((a) => ({ id: a.id, kind: a.kind, balanceSeconds: a.balanceSeconds, creator: a.creator }));
}

/** Achat d'une durée chez un créateur. Rien n'est crédité ici : le crédit passe uniquement par le règlement. */
export async function buyMinutes(user: User, input: { creatorId: string; offerId: string; operator: MobileOperator; phone: string }) {
  if (input.creatorId === user.id) throw badRequest('SELF_PURCHASE', 'Vous ne pouvez pas acheter vos propres minutes');
  const offer = await db.callMinuteOffer.findUnique({ where: { id: input.offerId } });
  if (!offer || !offer.active || offer.creatorId !== input.creatorId) throw notFound('Durée indisponible');
  const { rate, currency } = await creatorRate(input.creatorId, offer.kind);
  assertMobileMoneyCurrency(currency);
  if (!payments.operators().includes(input.operator)) throw badRequest('OPERATOR_UNAVAILABLE', 'Cet opérateur n’est pas disponible');
  const amount = minuteAmount(rate, offer.seconds);

  const existing = await db.callMinutePurchase.findFirst({
    where: { userId: user.id, offerId: offer.id, status: { in: ['PENDING', 'REVIEW'] } },
  });
  if (existing) throw conflict('PAYMENT_IN_PROGRESS', 'Un achat de minutes est déjà en cours', { purchaseId: existing.id });

  const purchase = await db.callMinutePurchase.create({
    data: {
      reference: ref(), userId: user.id, creatorId: input.creatorId, kind: offer.kind, offerId: offer.id,
      seconds: offer.seconds, grossAmount: amount, currency, operator: input.operator, payerPhoneHint: input.phone.slice(-4),
    },
  });
  // Rien n'est parti chez le prestataire si l'appel lève une exception : échec définitif, nouvel essai possible.
  let r;
  try {
    r = await payments.initiate({ reference: purchase.reference, amount, currency, operator: input.operator, phone: input.phone, description: 'Achat de minutes d’appel' });
  } catch (e) {
    await db.callMinutePurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    throw e;
  }
  if (r.status === 'REJECTED') {
    await db.callMinutePurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    throw badRequest('PAYMENT_FAILED', r.message || 'Paiement refusé');
  }
  if ((r.status === 'ACCEPTED' || r.status === 'REDIRECT') && r.providerRef) {
    await db.callMinutePurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { externalRef: r.providerRef } });
  }
  const current = await db.callMinutePurchase.findUniqueOrThrow({ where: { id: purchase.id } });
  return r.status === 'REDIRECT'
    ? { status: current.status, purchase: view(current), checkoutUrl: r.url }
    : { status: current.status, purchase: view(current) };
}

/** Statut d'un achat, pour son acheteur uniquement. */
export async function purchaseStatus(user: User, id: string) {
  const p = await db.callMinutePurchase.findUnique({ where: { id } });
  if (!p || p.userId !== user.id) throw notFound('Achat introuvable');
  return { purchase: view(p) };
}

/**
 * SEUL point de passage d'un achat de minutes vers PAID / FAILED / REVIEW (webhook, rapprochement). Idempotent.
 * Même règles que les achats de coins : succès tardif et montant inférieur au prix partent en REVIEW.
 */
export async function settleMinutePurchase(reference: string, o: { status: 'SUCCESS' | 'FAILED'; amount?: number; providerRef?: string; payload?: unknown }) {
  const payload = o.payload === undefined ? undefined : (JSON.parse(JSON.stringify(o.payload)) as Prisma.InputJsonValue);
  return db.$transaction(async (tx) => {
    const p = await tx.callMinutePurchase.findUnique({ where: { reference } });
    if (!p) return 'unknown' as const;
    if (p.status === 'PAID') return 'already' as const;
    if (o.status === 'SUCCESS') {
      if (p.status === 'FAILED') {
        await tx.callMinutePurchase.updateMany({ where: { id: p.id, status: 'FAILED' }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } });
        console.error(`[minutes] succès tardif sur un achat échoué (réf ${reference}) : vérification manuelle`);
        return 'review' as const;
      }
      if (o.amount !== undefined && o.amount < p.grossAmount) {
        await tx.callMinutePurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } });
        return 'review' as const;
      }
      const u = await tx.callMinutePurchase.updateMany({
        where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } },
        data: { status: 'PAID', paidAt: new Date(), reviewReason: null, externalRef: o.providerRef ?? p.externalRef, providerPayload: payload },
      });
      if (u.count !== 1) return 'already' as const;
      const account = await tx.callMinuteAccount.upsert({
        where: { userId_creatorId_kind: { userId: p.userId, creatorId: p.creatorId, kind: p.kind } },
        create: { userId: p.userId, creatorId: p.creatorId, kind: p.kind, balanceSeconds: 0 },
        update: {},
      });
      const updated = await tx.callMinuteAccount.update({ where: { id: account.id }, data: { balanceSeconds: { increment: p.seconds } } });
      await tx.callMinuteEntry.create({
        data: { accountId: account.id, type: 'PURCHASE', seconds: p.seconds, balanceAfter: updated.balanceSeconds, sourceType: 'CALL_MINUTE_PURCHASE', sourceId: p.id },
      });
      return 'paid' as const;
    }
    if (p.status === 'FAILED') return 'already' as const;
    const r = await tx.callMinutePurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'FAILED', providerPayload: payload } });
    return r.count === 1 ? ('failed' as const) : ('already' as const);
  });
}
