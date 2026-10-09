import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { forbidden } from '../../utils/errors';

export const REVENUE_RANGES = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;
export type RevenueRange = keyof typeof REVENUE_RANGES;
export type RevenueRow = { count: number; gross: number; commission: number; net: number };

/**
 * Assemble le résumé à partir des totaux des deux sources (cadeaux, pourboires). Pure et testable.
 * `consistent` vaut vrai si, dans chaque ligne comme dans le total, le brut est égal à la commission plus le net.
 */
export function buildRevenueSummary(range: RevenueRange, gifts: RevenueRow, tips: RevenueRow) {
  const total: RevenueRow = {
    count: gifts.count + tips.count,
    gross: gifts.gross + tips.gross,
    commission: gifts.commission + tips.commission,
    net: gifts.net + tips.net,
  };
  const ok = (r: RevenueRow) => r.gross === r.commission + r.net;
  return { range, currency: 'XAF', gifts, tips, total, consistent: ok(gifts) && ok(tips) && ok(total) };
}

/** Cadeaux et pourboires reçus par le créateur sur la période. Montants en coins, équivalents XAF comme crédités au portefeuille. */
export async function creatorGiftsSummary(viewer: User, range: RevenueRange) {
  if (!viewer.isCreator) throw forbidden('CREATOR_REQUIRED', 'Réservé aux comptes créateurs');
  const since = new Date(Date.now() - REVENUE_RANGES[range] * 86_400_000);
  const [gifts, tips] = await Promise.all([
    prisma.coinGiftTransaction.aggregate({ where: { creatorId: viewer.id, createdAt: { gte: since } }, _count: { _all: true }, _sum: { grossAmount: true, platformFee: true, creatorAmount: true } }),
    prisma.coinTipTransaction.aggregate({ where: { creatorId: viewer.id, createdAt: { gte: since } }, _count: { _all: true }, _sum: { amount: true, platformFee: true, creatorAmount: true } }),
  ]);
  return buildRevenueSummary(range,
    { count: gifts._count._all, gross: gifts._sum.grossAmount ?? 0, commission: gifts._sum.platformFee ?? 0, net: gifts._sum.creatorAmount ?? 0 },
    { count: tips._count._all, gross: tips._sum.amount ?? 0, commission: tips._sum.platformFee ?? 0, net: tips._sum.creatorAmount ?? 0 });
}

/** Vues et achats par vidéo sur la période, avec le revenu de vues et le revenu d'achats séparés. */
export async function creatorVideoStats(viewer: User, range: RevenueRange) {
  if (!viewer.isCreator) throw forbidden('CREATOR_REQUIRED', 'Réservé aux comptes créateurs');
  const since = new Date(Date.now() - REVENUE_RANGES[range] * 86_400_000);
  const [videos, shorts] = await Promise.all([
    prisma.video.findMany({ where: { authorId: viewer.id, deletedAt: null }, select: { id: true, title: true } }),
    prisma.short.findMany({ where: { authorId: viewer.id, deletedAt: null }, select: { id: true, title: true } }),
  ]);
  const info = new Map<string, { kind: 'VIDEO' | 'SHORT'; title: string }>();
  for (const v of videos) info.set(v.id, { kind: 'VIDEO', title: v.title });
  for (const s2 of shorts) info.set(s2.id, { kind: 'SHORT', title: s2.title });
  const ids = [...info.keys()];
  const [views, purchases, viewEarn, purchaseEarn] = await Promise.all([
    prisma.contentView.groupBy({
      by: ['targetId'], where: { targetType: { in: ['VIDEO', 'SHORT'] }, targetId: { in: ids }, createdAt: { gte: since } },
      _count: { _all: true }, _sum: { watchedSeconds: true },
    }),
    prisma.paidContentPurchase.groupBy({
      by: ['contentId'], where: { creatorId: viewer.id, status: 'PAID', paidAt: { gte: since }, contentId: { in: ids } },
      _count: { _all: true }, _sum: { creatorAmount: true },
    }),
    prisma.creatorEarning.aggregate({ where: { creatorId: viewer.id, source: { in: ['VIDEO', 'SHORT'] }, createdAt: { gte: since } }, _sum: { creatorAmount: true } }),
    prisma.creatorEarning.aggregate({ where: { creatorId: viewer.id, source: 'PAID_CONTENT', createdAt: { gte: since } }, _sum: { creatorAmount: true } }),
  ]);
  const viewBy = new Map(views.map((v) => [v.targetId, v]));
  const buyBy = new Map(purchases.map((p) => [p.contentId, p]));
  const items = ids.map((contentId) => {
    const meta = info.get(contentId)!;
    const v = viewBy.get(contentId);
    const b = buyBy.get(contentId);
    return {
      kind: meta.kind, contentId, title: meta.title,
      views: v?._count._all ?? 0, watchSeconds: v?._sum.watchedSeconds ?? 0,
      purchases: b?._count._all ?? 0, purchaseRevenue: b?._sum.creatorAmount ?? 0,
    };
  }).filter((i) => i.views > 0 || i.purchases > 0).sort((a, b) => b.views - a.views);
  return {
    range, currency: 'XAF', items,
    totals: {
      views: items.reduce((n, i) => n + i.views, 0),
      purchases: items.reduce((n, i) => n + i.purchases, 0),
      viewRevenue: viewEarn._sum.creatorAmount ?? 0,
      purchaseRevenue: purchaseEarn._sum.creatorAmount ?? 0,
    },
  };
}
