import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { payments, type MobileOperator } from '../../utils/payments';
import { splitAmount } from '../../utils/money';
import { recordCreatorEarning } from '../monetization/monetization.service';

const newReference = () => `S${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();
const BENEFIT_DEFAULTS = { exclusiveContent: false, privateLives: false, directMessages: false, subscriberCalls: false, includedCallMinutes: 0, downloads: false, other: [] as string[] };

const requireCreator = (user: User) => { if (!user.isCreator) throw forbidden('NOT_A_CREATOR', 'Activez les fonctions créateur pour proposer un abonnement'); };
const requirePrice = (price: number) => {
  if (price < env.CREATOR_SUBSCRIPTION_MIN_FCFA || price > env.CREATOR_SUBSCRIPTION_MAX_FCFA) {
    throw badRequest('INVALID_SUBSCRIPTION_PRICE', `Le prix doit être compris entre ${env.CREATOR_SUBSCRIPTION_MIN_FCFA} et ${env.CREATOR_SUBSCRIPTION_MAX_FCFA} FCFA`);
  }
};

const planDto = (p: any) => ({ id: p.id, creatorId: p.creatorId, priceFcfa: p.priceMinor, currency: p.currency, benefits: { ...BENEFIT_DEFAULTS, ...(p.benefits ?? {}) }, isActive: p.isActive, updatedAt: p.updatedAt });
const subscriptionDto = (s: any) => ({ id: s.id, creatorId: s.creatorId, subscriberId: s.subscriberId, status: s.status, priceFcfa: s.priceMinor, currency: s.currency, startedAt: s.startedAt, expiresAt: s.expiresAt, cancelledAt: s.cancelledAt, autoRenew: s.autoRenew, plan: s.plan ? planDto(s.plan) : undefined });

export async function getPlan(viewer: User, creatorId: string) {
  const creator = await prisma.user.findUnique({ where: { id: creatorId } });
  if (!creator || creator.status !== 'ACTIVE' || !creator.isCreator) throw notFound('Créateur introuvable');
  const plan = await prisma.creatorSubscriptionPlan.findUnique({ where: { creatorId } });
  return { plan: plan && plan.isActive ? planDto(plan) : null };
}

export async function getMyPlan(viewer: User) {
  requireCreator(viewer);
  const plan = await prisma.creatorSubscriptionPlan.findUnique({ where: { creatorId: viewer.id } });
  return { plan: plan ? planDto(plan) : null };
}

export async function updateMyPlan(viewer: User, input: { priceFcfa: number; benefits: any; isActive?: boolean }) {
  requireCreator(viewer);
  requirePrice(input.priceFcfa);
  const benefits = { ...BENEFIT_DEFAULTS, ...input.benefits };
  const plan = await prisma.creatorSubscriptionPlan.upsert({
    where: { creatorId: viewer.id },
    create: { creatorId: viewer.id, priceMinor: input.priceFcfa, currency: 'XAF', benefits, isActive: input.isActive ?? true },
    update: { priceMinor: input.priceFcfa, benefits, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) },
  });
  return { plan: planDto(plan) };
}

export async function getMySubscription(viewer: User, creatorId: string) {
  const row = await prisma.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId: viewer.id, creatorId } }, include: { plan: true } });
  return { subscription: row ? subscriptionDto(row) : null };
}

export async function hasActiveSubscription(subscriberId: string, creatorId: string) {
  const row = await prisma.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId, creatorId } }, select: { status: true, expiresAt: true } });
  return !!row && row.status === 'ACTIVE' && !!row.expiresAt && row.expiresAt > new Date();
}

export async function subscribe(viewer: User, creatorId: string, input: { operator: MobileOperator; phone: string }) {
  if (viewer.id === creatorId) throw badRequest('CANNOT_SUBSCRIBE_SELF', 'Vous ne pouvez pas vous abonner à vous-même');
  const creator = await prisma.user.findUnique({ where: { id: creatorId } });
  if (!creator || creator.status !== 'ACTIVE' || !creator.isCreator) throw notFound('Créateur introuvable');
  const plan = await prisma.creatorSubscriptionPlan.findUnique({ where: { creatorId } });
  if (!plan || !plan.isActive) throw conflict('SUBSCRIPTION_UNAVAILABLE', "Ce créateur n'a pas d'abonnement disponible");
  requirePrice(plan.priceMinor);
  if (plan.currency !== 'XAF') throw conflict('SUBSCRIPTION_CURRENCY_UNAVAILABLE', 'Cette offre utilise une devise qui n’est pas encore prise en charge par le paiement Mobile Money');
  const existing = await prisma.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId: viewer.id, creatorId } } });
  if (existing?.status === 'ACTIVE' && existing.expiresAt && existing.expiresAt > new Date()) throw conflict('ALREADY_SUBSCRIBED', 'Vous êtes déjà abonné à ce créateur');

  const split = splitAmount(plan.priceMinor, env.CREATOR_SUBSCRIPTION_COMMISSION_BPS);
  const reference = newReference();
  const subscription = existing
    ? await prisma.creatorSubscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: 'PENDING_PAYMENT', priceMinor: plan.priceMinor, currency: plan.currency, startedAt: null, expiresAt: null, cancelledAt: null } })
    : await prisma.creatorSubscription.create({ data: { subscriberId: viewer.id, creatorId, planId: plan.id, status: 'PENDING_PAYMENT', priceMinor: plan.priceMinor, currency: plan.currency } });
  const payment = await prisma.creatorSubscriptionPayment.create({ data: { subscriptionId: subscription.id, buyerId: viewer.id, creatorId, grossFcfa: split.grossAmount, commissionFcfa: split.platformFeeAmount, creatorFcfa: split.creatorAmount, commissionBps: split.commissionBps, reference, operator: input.operator, payerPhoneHint: input.phone.slice(-4) } });

  let result;
  try { result = await payments.initiate({ reference, amountFcfa: split.grossAmount, operator: input.operator, phone: input.phone, description: 'Abonnement créateur Face to Face' }); }
  catch (err) { await prisma.creatorSubscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED' } }); await prisma.creatorSubscription.update({ where: { id: subscription.id }, data: { status: existing?.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_PAYMENT' } }); throw err; }
  if (result.status === 'REJECTED') { await prisma.creatorSubscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', reviewReason: result.code } }); throw new AppError(402, 'PAYMENT_FAILED', result.message || 'Le paiement a été refusé', { code: result.code }); }
  if (result.status === 'ACCEPTED' && result.providerRef) await prisma.creatorSubscriptionPayment.update({ where: { id: payment.id }, data: { externalRef: result.providerRef } });
  const now = await prisma.creatorSubscription.findUniqueOrThrow({ where: { id: subscription.id }, include: { plan: true } });
  return { httpStatus: 202 as const, subscription: subscriptionDto(now), payment: { id: payment.id, status: 'PENDING', reference } };
}

export async function cancel(viewer: User, creatorId: string) {
  const row = await prisma.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId: viewer.id, creatorId } } });
  if (!row || row.status !== 'ACTIVE') throw notFound('Abonnement introuvable');
  const updated = await prisma.creatorSubscription.update({ where: { id: row.id }, data: { autoRenew: false, cancelledAt: new Date() }, include: { plan: true } });
  return { subscription: subscriptionDto(updated) };
}

export async function settleSubscriptionPayment(reference: string, outcome: { status: 'SUCCESS'|'FAILED'; amountFcfa?: number; providerRef?: string; payload?: unknown }) {
  return prisma.$transaction(async tx => {
    const p = await tx.creatorSubscriptionPayment.findUnique({ where: { reference }, include: { subscription: true } });
    if (!p) return 'unknown' as const;
    if (p.status === 'PAID') return 'already' as const;
    const payload = outcome.payload === undefined ? undefined : JSON.parse(JSON.stringify(outcome.payload));
    if (outcome.status === 'SUCCESS') {
      if (p.status === 'FAILED') { await tx.creatorSubscriptionPayment.update({ where: { id: p.id }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } }); return 'review' as const; }
      if (outcome.amountFcfa !== undefined && outcome.amountFcfa < p.grossFcfa) { await tx.creatorSubscriptionPayment.update({ where: { id: p.id }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } }); return 'review' as const; }
      const now = new Date();
      const r = await tx.creatorSubscriptionPayment.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'PAID', paidAt: now, providerPayload: payload, ...(outcome.providerRef ? { externalRef: outcome.providerRef } : {}) } });
      if (r.count !== 1) return 'already' as const;
      await tx.creatorSubscription.update({ where: { id: p.subscriptionId }, data: { status: 'ACTIVE', startedAt: now, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), cancelledAt: null, autoRenew: false } });
      await recordCreatorEarning(tx, { creatorId: p.creatorId, source: 'CREATOR_SUBSCRIPTION', sourceId: p.id, grossAmount: p.grossFcfa, currency: 'XAF', commissionBps: p.commissionBps, status: 'AVAILABLE' });
      return 'paid' as const;
    }
    const r = await tx.creatorSubscriptionPayment.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'FAILED', reviewReason: null, providerPayload: payload } });
    if (r.count === 1) await tx.creatorSubscription.updateMany({ where: { id: p.subscriptionId, status: 'PENDING_PAYMENT' }, data: { status: 'EXPIRED' } });
    return r.count === 1 ? 'failed' as const : 'already' as const;
  });
}
