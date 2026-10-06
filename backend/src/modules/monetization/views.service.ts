import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { normalizeCurrency } from './currency';
import { getConfigValue, getCurrentRuleVersion, updateConfig } from '../config/config.service';

const DEFAULT_PLATFORM_SHARE_BPS = 6000;
const DEFAULT_CREATOR_POOL_SHARE_BPS = 4000;

export type AdRevenueInput = {
  grossAmount: number;
  currency: string;
  receivedAt?: Date;
  externalReference?: string;
};

export function splitAdvertisingRevenue(grossAmount: number, creatorPoolShareBps = DEFAULT_CREATOR_POOL_SHARE_BPS) {
  if (!Number.isSafeInteger(grossAmount) || grossAmount < 0) throw new Error('Le revenu publicitaire doit être un entier positif');
  if (!Number.isInteger(creatorPoolShareBps) || creatorPoolShareBps < 0 || creatorPoolShareBps > 10_000) throw new Error('Part Creator Pool invalide');
  const creatorPoolAmount = Math.floor((grossAmount * creatorPoolShareBps) / 10_000);
  return {
    grossAmount,
    creatorPoolAmount,
    platformAmount: grossAmount - creatorPoolAmount,
    platformShareBps: 10_000 - creatorPoolShareBps,
    creatorPoolShareBps,
  };
}

export function allocatePoolAmount(poolAmount: number, creatorViews: Array<{ creatorId: string; qualifiedViews: bigint }>) {
  if (!Number.isSafeInteger(poolAmount) || poolAmount < 0) throw new Error('Montant du pool invalide');
  const total = creatorViews.reduce((n, x) => n + x.qualifiedViews, 0n);
  if (total === 0n) return { totalQualifiedViews: 0n, allocations: [] as Array<{ creatorId: string; qualifiedViews: bigint; shareBps: number; amount: number }> };

  // Allocation en unités mineures avec méthode du plus grand reste : tout le pool est distribué,
  // sans perte d'arrondi et sans utiliser de flottants pour les montants.
  const raw = creatorViews.map((x) => {
    const numerator = BigInt(poolAmount) * x.qualifiedViews;
    const base = numerator / total;
    const remainder = numerator % total;
    return { ...x, base: Number(base), remainder };
  });
  let remaining = poolAmount - raw.reduce((n, x) => n + x.base, 0);
  raw.sort((a, b) => b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.creatorId.localeCompare(b.creatorId));
  const allocations = raw.map((x) => {
    const bonus = remaining > 0 ? 1 : 0;
    if (bonus) remaining--;
    return {
      creatorId: x.creatorId,
      qualifiedViews: x.qualifiedViews,
      shareBps: Number((x.qualifiedViews * 10_000n) / total),
      amount: x.base + bonus,
    };
  }).sort((a, b) => a.creatorId.localeCompare(b.creatorId));
  return { totalQualifiedViews: total, allocations };
}

async function setting(db: Prisma.TransactionClient | typeof prisma, key: string, fallback: number, description: string) {
  return (await getConfigValue(key, fallback, db)) as number;
}

export async function getViewMonetizationSettings(db: Prisma.TransactionClient | typeof prisma = prisma) {
  const creatorPoolPercent = await setting(db, 'CREATOR_POOL.CREATOR_PERCENT', 40, 'Part des revenus publicitaires réellement encaissés versée au Creator Pool.');
  const creatorPoolShareBps = Math.round(creatorPoolPercent * 100);
  return {
    creatorPoolShareBps,
    platformShareBps: 10_000 - creatorPoolShareBps,
    formula: 'advertising_revenue * creator_pool_share / 10000',
  };
}

export async function setViewMonetizationSetting(key: 'CREATOR_POOL_SHARE_BPS', value: number, adminId: string, reason: string) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('La part Creator Pool doit être comprise entre 0 et 10000 bps');
  if (!reason.trim()) throw new Error('Une raison est obligatoire');
  if (key !== 'CREATOR_POOL_SHARE_BPS') throw new Error('Paramètre Creator Pool invalide');
  return updateConfig(adminId, 'CREATOR_POOL.CREATOR_PERCENT', { value: value / 100, reason });
}

/** Enregistre un revenu publicitaire réellement encaissé. Idempotence par référence externe quand elle est fournie. */
export async function recordAdvertisingRevenue(input: AdRevenueInput) {
  const currency = normalizeCurrency(input.currency);
  const settings = await getViewMonetizationSettings();
  const ruleVersion = await getCurrentRuleVersion();
  const split = splitAdvertisingRevenue(input.grossAmount, settings.creatorPoolShareBps);
  if (input.externalReference) {
    const existing = await prisma.advertisingRevenue.findUnique({ where: { externalReference: input.externalReference } });
    if (existing) return existing;
  }
  return prisma.advertisingRevenue.create({
    data: {
      externalReference: input.externalReference,
      currency,
      grossAmount: split.grossAmount,
      platformShareBps: split.platformShareBps,
      creatorPoolShareBps: split.creatorPoolShareBps,
      creatorPoolAmount: split.creatorPoolAmount,
      ruleVersion,
      receivedAt: input.receivedAt ?? new Date(),
    },
  });
}

type ViewRow = { targetType: 'VIDEO' | 'SHORT'; targetId: string; createdAt: Date; };
async function qualifiedViewsByCreator(db: Prisma.TransactionClient | typeof prisma, start: Date, end: Date) {
  const { getMonetizationConditions } = await import('./eligibility.service.js');
  const c = await getMonetizationConditions(db);
  const views = await db.contentView.findMany({
    where: { createdAt: { gte: start, lt: end }, watchedSeconds: { gt: 0 } },
    select: { userId: true, targetType: true, targetId: true, watchedSeconds: true },
  });
  const videoIds = [...new Set(views.filter(v => v.targetType === 'VIDEO').map(v => v.targetId))];
  const shortIds = [...new Set(views.filter(v => v.targetType === 'SHORT').map(v => v.targetId))];
  const [videos, shorts] = await Promise.all([
    db.video.findMany({ where: { id: { in: videoIds }, status: 'PUBLISHED', visibility: { not: 'PRIVATE' } }, select: { id: true, authorId: true, durationSeconds: true, isOriginal: true } }),
    db.short.findMany({ where: { id: { in: shortIds }, status: 'PUBLISHED', visibility: { not: 'PRIVATE' } }, select: { id: true, authorId: true, durationSeconds: true, isOriginal: true } }),
  ]);
  const owners = new Map<string, { authorId: string; durationSeconds: number | null; isOriginal: boolean; minWatched: number; minPercentBps: number }>();
  videos.forEach(v => owners.set(`VIDEO:${v.id}`, { authorId: v.authorId, durationSeconds: v.durationSeconds, isOriginal: v.isOriginal, minWatched: c.VIDEO_MIN_WATCHED_SECONDS, minPercentBps: c.VIDEO_MIN_WATCH_PERCENT_BPS }));
  shorts.forEach(v => owners.set(`SHORT:${v.id}`, { authorId: v.authorId, durationSeconds: v.durationSeconds, isOriginal: v.isOriginal, minWatched: c.SHORT_MIN_WATCHED_SECONDS, minPercentBps: c.SHORT_MIN_WATCH_PERCENT_BPS }));
  const counts = new Map<string, bigint>();
  for (const view of views) {
    const content = owners.get(`${view.targetType}:${view.targetId}`);
    if (!content || content.authorId === view.userId || !content.isOriginal) continue;
    const minDuration = view.targetType === 'VIDEO' ? c.VIDEO_MIN_DURATION_SECONDS : c.SHORT_MIN_DURATION_SECONDS;
    if (content.durationSeconds === null || content.durationSeconds < minDuration || view.watchedSeconds < content.minWatched) continue;
    if (content.durationSeconds > 0 && content.minPercentBps > 0 && view.watchedSeconds * 10_000 < content.durationSeconds * content.minPercentBps) continue;
    counts.set(content.authorId, (counts.get(content.authorId) ?? 0n) + 1n);
  }
  return [...counts.entries()].map(([creatorId, qualifiedViews]) => ({ creatorId, qualifiedViews }));
}

/** Agrège les revenus publicitaires d'une période puis les répartit selon les vues qualifiées. Idempotent par pool/période/devise. */
export async function allocateCreatorPool(start: Date, end: Date, currencyInput: string) {
  const currency = normalizeCurrency(currencyInput);
  return prisma.$transaction(async (tx) => {
    const revenues = await tx.advertisingRevenue.findMany({
      where: { currency, receivedAt: { gte: start, lt: end }, status: { in: ['RECEIVED', 'ALLOCATED'] } },
      orderBy: { receivedAt: 'asc' },
    });
    const grossAdRevenue = revenues.reduce((n, r) => n + r.grossAmount, 0);
    const creatorPoolAmount = revenues.reduce((n, r) => n + r.creatorPoolAmount, 0);
    const existing = await tx.creatorPool.findUnique({ where: { periodStart_periodEnd_currency: { periodStart: start, periodEnd: end, currency } } });
    if (existing?.status === 'ALLOCATED') return existing;

    const counts = await qualifiedViewsByCreator(tx, start, end);
    const distribution = allocatePoolAmount(creatorPoolAmount, counts);
    const ruleVersion = await getCurrentRuleVersion(tx);
    const pool = existing ?? await tx.creatorPool.create({
      data: { periodStart: start, periodEnd: end, currency, grossAdRevenue, creatorPoolAmount, qualifiedViews: distribution.totalQualifiedViews, status: 'OPEN', ruleVersion },
    });
    if (existing) {
      await tx.creatorPool.update({ where: { id: pool.id }, data: { grossAdRevenue, creatorPoolAmount, qualifiedViews: distribution.totalQualifiedViews } });
    }

    for (const a of distribution.allocations) {
      const allocation = await tx.creatorViewAllocation.upsert({
        where: { poolId_creatorId: { poolId: pool.id, creatorId: a.creatorId } },
        create: { poolId: pool.id, creatorId: a.creatorId, currency, qualifiedViews: a.qualifiedViews, totalQualifiedViews: distribution.totalQualifiedViews, shareBps: a.shareBps, grossAmount: a.amount },
        update: { qualifiedViews: a.qualifiedViews, totalQualifiedViews: distribution.totalQualifiedViews, shareBps: a.shareBps, grossAmount: a.amount, status: 'ALLOCATED' },
      });
      await tx.creatorEarning.upsert({
        where: { source_sourceId: { source: 'CREATOR_POOL', sourceId: allocation.id } },
        create: {
          creatorId: a.creatorId, source: 'CREATOR_POOL', sourceId: allocation.id,
          grossAmount: a.amount, platformFeeAmount: 0, creatorAmount: a.amount, currency,
          commissionBps: 0, status: 'AVAILABLE', ruleVersion: pool.ruleVersion ?? ruleVersion,
          availableAt: new Date(),
        },
        update: {},
      });
    }

    const allocated = await tx.creatorPool.update({ where: { id: pool.id }, data: { allocatedAmount: creatorPoolAmount, status: 'ALLOCATED', allocatedAt: new Date() } });
    if (revenues.length) await tx.advertisingRevenue.updateMany({ where: { id: { in: revenues.map(r => r.id) } }, data: { status: 'ALLOCATED', creatorPoolId: pool.id } });
    return allocated;
  });
}

export async function getCreatorViewEarnings(viewer: User, currency?: string) {
  if (!viewer.isCreator) return { pools: [] };
  const where = { creatorId: viewer.id, ...(currency ? { currency: normalizeCurrency(currency) } : {}) };
  const rows = await prisma.creatorViewAllocation.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, poolId: true, currency: true, qualifiedViews: true, totalQualifiedViews: true, shareBps: true, grossAmount: true, createdAt: true, status: true },
  });
  return { pools: rows.map(r => ({ ...r, qualifiedViews: r.qualifiedViews.toString(), totalQualifiedViews: r.totalQualifiedViews.toString() })) };
}
