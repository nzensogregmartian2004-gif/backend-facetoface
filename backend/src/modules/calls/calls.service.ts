import { DEFAULT_CURRENCY, formatAmountText, limitIn, SUPPORTED_CURRENCIES } from '../../utils/currency';
import type { Call, CreatorCallSettings, Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { callProvider } from '../../utils/callProvider';
import { decodeCursor, encodeCursor } from '../../utils/cursor';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { payments } from '../../utils/payments';
import { blockedIdsFor } from '../content/access';
import { toUserCards } from '../users/profile.service';
import { billCall, billSeconds } from './calls.billing';
import { creatorRate } from './callMinutes.service';
import { isUserOnline } from '../../realtime/realtime';
import { lockUser } from './calls.lock';
import { serializeCall } from './calls.serializer';
import { recordPaidCallEarning } from '../monetization/monetization.service';

/** Référence marchand : ≤ 13 caractères (exigence MyPVit), unique, non devinable. Préfixe `C` = appel (les messages payants utilisent `M`). */

const IN_PROGRESS = ['AWAITING_PAYMENT', 'RINGING', 'ACTIVE'] as const;
const LIVE = ['RINGING', 'ACTIVE'] as const;

/** Paramètres publics des appels (le mobile ne doit rien coder en dur). */
export const settings = () => {
  const operators = payments.operators();
  return {
    enabled: callProvider.configured() && operators.length > 0,
    provider: callProvider.name,
    payments: { enabled: operators.length > 0, operators, feePayer: env.PAYMENT_FEE_PAYER },
    currencies: SUPPORTED_CURRENCIES,
    /** Bornes par devise, en unités mineures (le mobile valide la saisie avec elles). */
    limits: {
      maxDurationMinutes: env.CALL_MAX_DURATION_MINUTES,
      byCurrency: Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c, { minPrice: limitIn(env.CALL_MIN_PRICE_FCFA, c), maxPrice: limitIn(env.CALL_MAX_PRICE_FCFA, c), maxTotal: limitIn(env.CALL_MAX_TOTAL_FCFA, c) }])),
    },
    ringSeconds: env.CALL_RING_SECONDS,
    minBillableSeconds: env.CALL_MIN_BILLABLE_SECONDS,
    commissionBps: env.CALL_COMMISSION_BPS,
    disputeDays: env.CALL_DISPUTE_DAYS,
  };
};

// ── Réglages du créateur ─────────────────────────────────────────
const settingsDto = (s: CreatorCallSettings | null) => ({
  pricingMode: s?.pricingMode ?? 'PER_MINUTE',
  currency: s?.currency ?? DEFAULT_CURRENCY,
  audioPrice: s?.audioPrice ?? null,
  videoPrice: s?.videoPrice ?? null,
  maxDurationMinutes: Math.min(s?.maxDurationMinutes ?? 30, env.CALL_MAX_DURATION_MINUTES),
  access: s?.access ?? 'EVERYONE',
  isAvailable: s?.isAvailable ?? false,
});

const requireCreator = (viewer: User) => {
  if (!viewer.isCreator) throw forbidden('NOT_A_CREATOR', 'Activez les fonctions créateur pour recevoir des appels');
};

export async function getMySettings(viewer: User) {
  requireCreator(viewer);
  return { settings: settingsDto(await prisma.creatorCallSettings.findUnique({ where: { userId: viewer.id } })) };
}

export async function updateMySettings(viewer: User, input: { pricingMode?: 'PER_MINUTE' | 'PER_SESSION'; currency?: string; audioPrice?: number | null; videoPrice?: number | null; maxDurationMinutes?: number; access?: 'EVERYONE' | 'FOLLOWERS' | 'SUBSCRIBERS'; isAvailable?: boolean }) {
  requireCreator(viewer);
  const current = settingsDto(await prisma.creatorCallSettings.findUnique({ where: { userId: viewer.id } }));
  const currencyChanged = input.currency !== undefined && input.currency !== current.currency;
  // Un prix est exprimé en unités mineures d'UNE devise : changer de devise sans redonner de prix le réinitialiserait de façon trompeuse.
  const base = currencyChanged ? { ...current, audioPrice: null, videoPrice: null } : current;
  const next = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as typeof current;
  const details: Record<string, string> = {};
  const priceError = (v: number | null | undefined) => (v != null && (v < limitIn(env.CALL_MIN_PRICE_FCFA, next.currency) || v > limitIn(env.CALL_MAX_PRICE_FCFA, next.currency)) ? `Entre ${formatAmountText(limitIn(env.CALL_MIN_PRICE_FCFA, next.currency), next.currency)} et ${formatAmountText(limitIn(env.CALL_MAX_PRICE_FCFA, next.currency), next.currency)}` : null);
  const a = priceError(next.audioPrice); if (a) details.audioPrice = a;
  const v = priceError(next.videoPrice); if (v) details.videoPrice = v;
  if (input.maxDurationMinutes !== undefined && input.maxDurationMinutes > env.CALL_MAX_DURATION_MINUTES) details.maxDurationMinutes = `${env.CALL_MAX_DURATION_MINUTES} minutes maximum`;
  if (Object.keys(details).length) throw badRequest('INVALID_CALL_SETTINGS', 'Réglages invalides', details);
  if (next.isAvailable && next.audioPrice == null && next.videoPrice == null) throw badRequest('NO_CALL_PRICE', 'Fixez un prix (audio ou vidéo) avant de vous rendre disponible', { isAvailable: 'Aucun prix défini' });
  const data = { pricingMode: next.pricingMode, currency: next.currency, audioPrice: next.audioPrice, videoPrice: next.videoPrice, maxDurationMinutes: next.maxDurationMinutes, access: next.access, isAvailable: next.isAvailable };
  const saved = await prisma.creatorCallSettings.upsert({ where: { userId: viewer.id }, create: { userId: viewer.id, ...data }, update: data });
  return { settings: settingsDto(saved) };
}

// ── Autorisation d'appeler (modèle : messagingPermission) ──────────
const isBlocked = async (a: string, b: string) => !!(await prisma.block.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }, select: { id: true } }));

async function loadCallee(viewer: User, calleeId: string): Promise<User> {
  if (calleeId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Action impossible sur votre propre compte');
  const callee = await prisma.user.findUnique({ where: { id: calleeId } });
  if (!callee || callee.status !== 'ACTIVE' || !callee.isCreator) throw notFound('Créateur introuvable');
  if (await isBlocked(viewer.id, callee.id)) throw notFound('Créateur introuvable');
  return callee;
}

type Eligibility = { allowed: true; settings: CreatorCallSettings } | { allowed: false; code: string; message: string };

/** Le créateur accepte-t-il un appel de ce type de la part de `viewer` ? (réglages, accès, disponibilité ; l'occupation est vérifiée à part). */
async function eligibility(viewer: User, callee: User, type: 'AUDIO' | 'VIDEO' | null): Promise<Eligibility> {
  const s = await prisma.creatorCallSettings.findUnique({ where: { userId: callee.id } });
  if (!s || !s.isAvailable) return { allowed: false, code: 'CREATOR_UNAVAILABLE', message: "Ce créateur n'est pas disponible pour des appels" };
  if (type && (type === 'AUDIO' ? s.audioPrice : s.videoPrice) == null) return { allowed: false, code: 'CALL_TYPE_UNAVAILABLE', message: type === 'AUDIO' ? "Ce créateur ne propose pas d'appel audio" : "Ce créateur ne propose pas d'appel vidéo" };
  if (s.access === 'FOLLOWERS') {
    const follows = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer.id, followingId: callee.id } }, select: { id: true } });
    if (!follows) return { allowed: false, code: 'CALL_FOLLOWERS_ONLY', message: 'Suivez ce créateur pour pouvoir l’appeler' };
  }
  if (s.access === 'SUBSCRIBERS') {
    const { hasActiveSubscription } = await import('../subscriptions/subscriptions.service.js');
    if (!(await hasActiveSubscription(viewer.id, callee.id))) return { allowed: false, code: 'CALL_SUBSCRIBERS_ONLY', message: 'Abonnez-vous à ce créateur pour pouvoir l’appeler' };
  }
  return { allowed: true, settings: s };
}

const creatorBusy = async (db: Prisma.TransactionClient | typeof prisma, userId: string, exceptId?: string) =>
  (await db.call.count({ where: { ...(exceptId ? { id: { not: exceptId } } : {}), status: { in: [...LIVE] }, OR: [{ calleeId: userId }, { callerId: userId }] } })) > 0;

/** Offre d'appel d'un créateur, vue par `viewer` : tarifs, disponibilité et — si l'appel est impossible — la raison. */
export async function getOffer(viewer: User, calleeId: string) {
  const callee = await loadCallee(viewer, calleeId);
  const e = await eligibility(viewer, callee, null);
  const s = settings();
  if (!e.allowed) return { offer: null, canCall: false, reason: { code: e.code, message: e.message } };
  const busy = await creatorBusy(prisma, callee.id);
  const d = settingsDto(e.settings);
  const reason = !s.enabled ? { code: 'CALLS_NOT_CONFIGURED', message: 'Les appels ne sont pas encore disponibles' } : !isUserOnline(callee.id) ? { code: 'CREATOR_OFFLINE', message: 'Ce créateur est hors ligne' } : busy ? { code: 'CREATOR_BUSY', message: 'Ce créateur est en ligne avec quelqu’un d’autre' } : null;
  return { offer: { pricingMode: d.pricingMode, currency: d.currency, audioPrice: d.audioPrice, videoPrice: d.videoPrice, maxDurationMinutes: d.maxDurationMinutes, access: d.access, busy }, canCall: !reason, reason };
}

// ── Chargement / sérialisation ──────────────────────────────────
async function view(viewer: User, c: Call) {
  const otherId = c.callerId === viewer.id ? c.calleeId : c.callerId;
  const other = await prisma.user.findUniqueOrThrow({ where: { id: otherId } });
  const [card] = await toUserCards(viewer, [other]);
  return serializeCall(c, viewer, card);
}

/** Appel visible par `viewer` : les deux participants, mais le créateur ne voit jamais une demande non payée. 404 sinon. */
async function loadParticipant(viewer: User, id: string): Promise<Call> {
  const c = await settleDeadlines(id);
  if (!c || (c.callerId !== viewer.id && !(c.calleeId === viewer.id && c.paymentStatus === 'PAID'))) throw notFound('Appel introuvable');
  return c;
}

// ── Échéances : sonnerie expirée, durée maximale atteinte ──────────
/** Clôt un appel qui n'a pas été décroché : rien n'est consommé ni versé au créateur, et rien n'est remboursé (tout achat est définitif). */
async function closeUnanswered(c: Call, status: 'MISSED' | 'DECLINED' | 'CANCELLED', reason: 'RING_TIMEOUT' | 'DECLINED' | 'CANCELLED', at: Date): Promise<boolean> {
  const r = await prisma.call.updateMany({
    where: { id: c.id, status: 'RINGING' },
    data: { status, endReason: reason, endedAt: at, ringExpiresAt: null, consumedAmount: 0, commissionAmount: c.grossAmount, creatorAmount: 0, refundAmount: 0, refundStatus: 'NONE' },
  });
  return r.count === 1;
}

/** Durée maximale d'un appel payé en minutes : le solde de l'appelant, plafonné par le réglage du créateur. */
async function accountCapSeconds(c: Call): Promise<number> {
  const acc = await prisma.callMinuteAccount.findUnique({ where: { userId_creatorId_kind: { userId: c.callerId, creatorId: c.calleeId, kind: c.type } } });
  const s = await prisma.creatorCallSettings.findUnique({ where: { userId: c.calleeId }, select: { maxDurationMinutes: true } });
  const maxSeconds = Math.min(s?.maxDurationMinutes ?? 30, env.CALL_MAX_DURATION_MINUTES) * 60;
  return Math.min(acc?.balanceSeconds ?? 0, maxSeconds);
}

/** Débite le compte de minutes de l'appelant (au plus une fois par appel : appelé uniquement dans la transaction de clôture). */
async function debitMinutes(tx: Prisma.TransactionClient, c: Call, seconds: number): Promise<void> {
  const acc = await tx.callMinuteAccount.findUnique({ where: { userId_creatorId_kind: { userId: c.callerId, creatorId: c.calleeId, kind: c.type } } });
  if (!acc || acc.balanceSeconds < seconds) throw new Error(`[appels] solde de minutes insuffisant au décompte de l'appel ${c.id}`);
  const updated = await tx.callMinuteAccount.update({ where: { id: acc.id }, data: { balanceSeconds: { decrement: seconds } } });
  await tx.callMinuteEntry.create({ data: { accountId: acc.id, type: 'CALL_DEBIT', seconds: -seconds, balanceAfter: updated.balanceSeconds, sourceType: 'CALL', sourceId: c.id } });
}

/** Clôt un appel en cours : décompte à la seconde du compte de minutes (nouveau modèle). Les appels de l'ancien modèle suivent endLegacy. */
async function endActive(c: Call, at: Date, reason: 'HANGUP' | 'MAX_DURATION'): Promise<boolean> {
  if (c.reference) return endLegacy(c, at, reason);
  const started = c.answeredAt ?? at;
  const capSeconds = Math.round(((c.endsAt ?? at).getTime() - started.getTime()) / 1000);
  const elapsed = Math.max(0, Math.floor((at.getTime() - started.getTime()) / 1000));
  const actual = Math.max(0, Math.min(capSeconds, elapsed));
  const bill = billSeconds(c.unitPrice, actual, env.CALL_MIN_BILLABLE_SECONDS, c.commissionBps);
  // Clôture, débit et revenu du créateur dans UNE transaction : jamais de tâche lancée en arrière-plan.
  const r = await prisma.$transaction(async (tx) => {
    const u = await tx.call.updateMany({
      where: { id: c.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endReason: reason, endedAt: at, actualSeconds: actual, consumedAmount: bill.consumedAmount, commissionAmount: bill.commissionAmount, creatorAmount: bill.creatorAmount, refundAmount: 0, refundStatus: 'NONE' },
    });
    if (u.count !== 1) return u;
    if (bill.consumedSeconds > 0) await debitMinutes(tx, c, bill.consumedSeconds);
    if (bill.creatorAmount > 0) {
      await recordPaidCallEarning(tx, { id: c.id, calleeId: c.calleeId, consumedAmount: bill.consumedAmount, commissionAmount: bill.commissionAmount, creatorAmount: bill.creatorAmount, commissionBps: c.commissionBps, currency: c.currency });
    }
    return u;
  });
  if (r.count === 1) await Promise.resolve(callProvider.closeRoom(c.id)).catch((e) => console.error('[appel] fermeture de salle échouée', c.id, e));
  return r.count === 1;
}

/** Ancien modèle (paiement par appel) : appels déjà en cours au moment de la mise à jour. */
/** Clôt un appel en cours et en fixe le décompte d'après la durée réelle (plafonnée à la durée prépayée). */
async function endLegacy(c: Call, at: Date, reason: 'HANGUP' | 'MAX_DURATION'): Promise<boolean> {
  const started = c.answeredAt ?? at;
  const actual = Math.min(c.requestedMinutes * 60, Math.max(0, Math.floor((at.getTime() - started.getTime()) / 1000)));
  const bill = billCall(c, actual, env.CALL_MIN_BILLABLE_SECONDS);
  // Clôture + revenu du créateur dans UNE transaction : jamais de tâche lancée « en arrière-plan » (argent perdu ou écrit après coup).
  const r = await prisma.$transaction(async (tx) => {
    const u = await tx.call.updateMany({
      where: { id: c.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endReason: reason, endedAt: at, actualSeconds: actual, consumedAmount: bill.consumedAmount, commissionAmount: bill.commissionAmount, creatorAmount: bill.creatorAmount, refundAmount: bill.refundAmount, refundStatus: bill.refundAmount > 0 ? 'DUE' : 'NONE' },
    });
    if (u.count === 1 && bill.creatorAmount > 0) {
      await recordPaidCallEarning(tx, { id: c.id, calleeId: c.calleeId, consumedAmount: bill.consumedAmount, commissionAmount: bill.commissionAmount, creatorAmount: bill.creatorAmount, commissionBps: c.commissionBps, currency: c.currency });
    }
    return u;
  });
  if (r.count === 1) await Promise.resolve(callProvider.closeRoom(c.id)).catch((e) => console.error('[appel] fermeture de salle échouée', c.id, e));
  return r.count === 1;
}

async function applyDeadline(c: Call, now: Date): Promise<void> {
  if (c.status === 'RINGING' && c.ringExpiresAt && c.ringExpiresAt <= now) await closeUnanswered(c, 'MISSED', 'RING_TIMEOUT', c.ringExpiresAt);
  else if (c.status === 'ACTIVE' && c.endsAt && c.endsAt <= now) await endActive(c, c.endsAt, 'MAX_DURATION');
}

/** Applique les échéances d'un appel avant de le lire ou d'agir dessus (le balayage périodique fait de même pour tous). */
async function settleDeadlines(id: string): Promise<Call | null> {
  const c = await prisma.call.findUnique({ where: { id } });
  if (!c) return null;
  await applyDeadline(c, new Date());
  return prisma.call.findUnique({ where: { id } });
}

/** Balayage périodique : sonneries expirées et durées maximales atteintes (un appel dont l'application a planté se clôt tout seul). Idempotent. */
export async function sweepCalls(now = new Date()) {
  const rows = await prisma.call.findMany({
    where: { OR: [{ status: 'RINGING', ringExpiresAt: { lte: now } }, { status: 'ACTIVE', endsAt: { lte: now } }] },
    orderBy: { createdAt: 'asc' }, take: 200,
  });
  for (const c of rows) await applyDeadline(c, now);
  return { processed: rows.length };
}

export function startCallSweeper(): NodeJS.Timeout | null {
  if (env.CALL_PROVIDER === 'none') return null;
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { await sweepCalls(); } catch (e) { console.error('[appels] balayage en erreur', e); } finally { running = false; }
  }, env.CALL_SWEEP_INTERVAL_SECONDS * 1000);
  t.unref();
  return t;
}

// ── Demande d'appel (minutes du client, débit à la fin de l'appel) ─
/**
 * Demande d'appel. Aucun paiement ici : le client doit avoir des minutes de ce type chez ce créateur.
 * Réponses : 201 `{ call }` (la sonnerie part tout de suite) ; 402 NO_MINUTES ; 403 appel non autorisé ;
 * 409 créateur hors ligne, occupé, ou appel déjà en cours ; 503 appels non configurés.
 * Rien n'est débité à la demande ni au décroché : le décompte se fait à la fin, à la seconde.
 */
export async function requestCall(viewer: User, input: { calleeId: string; type: 'AUDIO' | 'VIDEO' }) {
  const callee = await loadCallee(viewer, input.calleeId);
  if (!callProvider.configured()) throw new AppError(503, 'CALLS_NOT_CONFIGURED', "Les appels ne sont pas encore configurés sur ce serveur");
  const e = await eligibility(viewer, callee, input.type);
  if (!e.allowed) throw forbidden(e.code, e.message);
  const rate = await creatorRate(callee.id, input.type);
  if (!isUserOnline(callee.id)) throw conflict('CREATOR_OFFLINE', 'Ce créateur est hors ligne. Réessayez quand il sera en ligne.');
  const account = await prisma.callMinuteAccount.findUnique({ where: { userId_creatorId_kind: { userId: viewer.id, creatorId: callee.id, kind: input.type } } });
  const available = account?.balanceSeconds ?? 0;
  if (available < Math.max(1, env.CALL_MIN_BILLABLE_SECONDS)) {
    throw new AppError(402, 'NO_MINUTES', "Vous n'avez pas de minutes pour cet appel. Achetez des minutes chez ce créateur.", { creatorId: callee.id, kind: input.type });
  }
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    await lockUser(tx, viewer.id); // un double clic ne crée pas deux appels
    const mine = await tx.call.findFirst({ where: { OR: [{ callerId: viewer.id, status: { in: [...IN_PROGRESS] } }, { calleeId: viewer.id, status: { in: [...LIVE] } }] }, select: { id: true } });
    if (mine) throw conflict('CALL_IN_PROGRESS', 'Vous avez déjà un appel en cours', { callId: mine.id });
    if (await creatorBusy(tx, callee.id)) throw conflict('CREATOR_BUSY', 'Ce créateur est en ligne avec quelqu’un d’autre, réessayez dans un instant');
    return tx.call.create({
      data: {
        callerId: viewer.id, calleeId: callee.id, type: input.type, pricingMode: 'PER_MINUTE', currency: rate.currency,
        unitPrice: rate.rate, requestedMinutes: Math.max(1, Math.ceil(available / 60)), grossAmount: 0,
        commissionBps: env.CALL_COMMISSION_BPS, status: 'RINGING', paymentStatus: 'PAID', paidAt: now,
        ringExpiresAt: new Date(now.getTime() + env.CALL_RING_SECONDS * 1000),
      },
    });
  }, { maxWait: 10_000, timeout: 20_000 });
  return { httpStatus: 201 as const, call: await view(viewer, created) };
}

// ── Lecture ─────────────────────────────────────────────────────
export async function getCall(viewer: User, id: string) {
  return { call: await view(viewer, await loadParticipant(viewer, id)) };
}

/** Appels en train de sonner chez `viewer` (sondé par l'application tant que le temps réel n'existe pas : étape 22). */
export async function incomingCalls(viewer: User) {
  const blocked = await blockedIdsFor(viewer.id);
  const rows = await prisma.call.findMany({
    where: { calleeId: viewer.id, status: 'RINGING', paymentStatus: 'PAID', ringExpiresAt: { gt: new Date() }, callerId: { notIn: blocked } },
    orderBy: { createdAt: 'desc' }, take: 5,
  });
  return { items: await Promise.all(rows.map((c) => view(viewer, c))) };
}

/** Historique : appels passés et reçus, du plus récent au plus ancien. Le créateur ne voit que les appels payés. */
export async function listCalls(viewer: User, o: { cursor?: string; limit: number }) {
  const c = decodeCursor(o.cursor);
  if (c && (typeof c.t !== 'number' || typeof c.i !== 'string')) throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
  const t = c ? new Date(c.t as number) : null;
  const where: Prisma.CallWhereInput = {
    AND: [
      { OR: [{ callerId: viewer.id, callerHiddenAt: null }, { calleeId: viewer.id, paymentStatus: 'PAID', calleeHiddenAt: null }] },
      ...(t ? [{ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: String(c!.i) } }] }] : []),
    ],
  };
  const rows = await prisma.call.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: o.limit + 1 });
  const page = rows.slice(0, o.limit);
  const others = await prisma.user.findMany({ where: { id: { in: page.map((r) => (r.callerId === viewer.id ? r.calleeId : r.callerId)) } } });
  const cards = await toUserCards(viewer, others);
  const cardById = new Map(others.map((u, i) => [u.id, cards[i]]));
  const items = page.map((r) => serializeCall(r, viewer, cardById.get(r.callerId === viewer.id ? r.calleeId : r.callerId) ?? null));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > o.limit && last ? encodeCursor({ t: last.createdAt.getTime(), i: last.id }) : null };
}

// ── Actions sur un appel ────────────────────────────────────────
const notPossible = (code: string, message: string) => conflict(code, message);

/** Le créateur décroche : le décompte démarre ICI (durée maximale = durée prépayée). Un seul appel en cours à la fois par personne. */
export async function acceptCall(viewer: User, id: string) {
  const c = await loadParticipant(viewer, id);
  if (c.calleeId !== viewer.id) throw notFound('Appel introuvable');
  if (await isBlocked(viewer.id, c.callerId)) throw notFound('Appel introuvable');
  if (c.status !== 'RINGING') throw notPossible('CALL_NOT_RINGING', "Cet appel n'est plus en attente");
  const now = new Date();
  const endMs = c.reference ? c.requestedMinutes * 60_000 : (await accountCapSeconds(c)) * 1000;
  if (!c.reference && endMs < Math.max(1, env.CALL_MIN_BILLABLE_SECONDS) * 1000) throw notPossible('NO_MINUTES', "Le compte de minutes de l'appelant ne suffit plus pour cet appel");
  const outcome = await prisma.$transaction(async (tx) => {
    await lockUser(tx, viewer.id);
    if (await creatorBusy(tx, viewer.id, c.id)) return 'busy' as const;
    const r = await tx.call.updateMany({
      where: { id: c.id, status: 'RINGING', ringExpiresAt: { gt: now } },
      data: { status: 'ACTIVE', answeredAt: now, endsAt: new Date(now.getTime() + endMs), ringExpiresAt: null },
    });
    return r.count === 1 ? ('ok' as const) : ('gone' as const);
  });
  if (outcome === 'busy') throw notPossible('CALL_IN_PROGRESS', 'Vous avez déjà un appel en cours');
  if (outcome === 'gone') throw notPossible('CALL_NOT_RINGING', "Cet appel n'est plus en attente");
  return getCall(viewer, id);
}

/** Le créateur refuse : rien n'est consommé, remboursement dû. */
export async function declineCall(viewer: User, id: string) {
  const c = await loadParticipant(viewer, id);
  if (c.calleeId !== viewer.id) throw notFound('Appel introuvable');
  if (c.status !== 'RINGING' || !(await closeUnanswered(c, 'DECLINED', 'DECLINED', new Date()))) throw notPossible('CALL_NOT_RINGING', "Cet appel n'est plus en attente");
  return getCall(viewer, id);
}

/** L'appelant raccroche avant la réponse : rien n'est consommé, remboursement dû. Pendant la validation du paiement, on ne peut pas annuler. */
export async function cancelCall(viewer: User, id: string) {
  const c = await loadParticipant(viewer, id);
  if (c.callerId !== viewer.id) throw notFound('Appel introuvable');
  if (c.status === 'AWAITING_PAYMENT') throw notPossible('PAYMENT_IN_PROGRESS', 'Le paiement est en cours de validation sur votre téléphone');
  if (c.status !== 'RINGING' || !(await closeUnanswered(c, 'CANCELLED', 'CANCELLED', new Date()))) throw notPossible('CALL_NOT_RINGING', "Cet appel n'est plus en attente");
  return getCall(viewer, id);
}

/** Raccrocher (l'un ou l'autre). Idempotent : déjà terminé → renvoie l'appel tel quel. */
export async function endCall(viewer: User, id: string) {
  const c = await loadParticipant(viewer, id);
  if (c.status === 'ACTIVE') await endActive(c, new Date(), 'HANGUP');
  else if (c.status !== 'ENDED') throw notPossible('CALL_NOT_ACTIVE', "Cet appel n'est pas en cours");
  return getCall(viewer, id);
}

/** Jeton d'accès à la salle : uniquement pour un appel PAYÉ, ACCEPTÉ et en cours, valable au plus jusqu'à la fin de la durée prépayée. */
export async function callToken(viewer: User, id: string) {
  const c = await loadParticipant(viewer, id);
  if (c.status !== 'ACTIVE' || !c.endsAt) throw notPossible('CALL_NOT_ACTIVE', "Cet appel n'est pas en cours");
  if (!callProvider.configured()) throw new AppError(503, 'CALLS_NOT_CONFIGURED', "Les appels ne sont pas encore configurés sur ce serveur");
  const remaining = Math.ceil((c.endsAt.getTime() - Date.now()) / 1000);
  if (remaining < 1) throw notPossible('CALL_NOT_ACTIVE', "Cet appel n'est pas en cours");
  const grant = callProvider.grant({ room: c.id, identity: viewer.id, displayName: viewer.displayName, video: c.type === 'VIDEO', ttlSeconds: Math.min(remaining, 3600) });
  return { grant, call: await view(viewer, c) };
}

/** Litige ouvert par le payeur sur un appel terminé et facturé ; traité par l'administration (étape 16). Un seul litige par appel. */
export async function disputeCall(viewer: User, id: string, reason: string) {
  const c = await loadParticipant(viewer, id);
  if (c.callerId !== viewer.id) throw notFound('Appel introuvable');
  if (c.status !== 'ENDED' || !c.endedAt || (c.consumedAmount ?? 0) <= 0) throw notPossible('CALL_NOT_DISPUTABLE', "Seul un appel terminé et facturé peut faire l'objet d'un litige");
  if (Date.now() - c.endedAt.getTime() > env.CALL_DISPUTE_DAYS * 86_400_000) throw notPossible('DISPUTE_WINDOW_CLOSED', `Le délai de ${env.CALL_DISPUTE_DAYS} jours pour contester cet appel est dépassé`);
  const r = await prisma.call.updateMany({ where: { id: c.id, disputedAt: null }, data: { disputedAt: new Date(), disputeReason: reason } });
  if (r.count !== 1) throw notPossible('ALREADY_DISPUTED', 'Un litige est déjà ouvert pour cet appel');
  return getCall(viewer, id);
}
