import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { loadInteractive } from './access';
import { foldRows, rangeStart, summarizeRetention, type GroupRow, type RetentionRange } from './shortRetention.policy';

export type WatchSession = { clientSessionId: string; watchedMs: number; completed: boolean };

/**
 * Reçoit un lot de sessions de lecture d'un Short (étape 11).
 * - Une session déjà reçue (même clientSessionId) est mise à jour si le temps a augmenté : le mobile renvoie un instantané
 *   pendant la lecture, puis le total final. Un lot rejoué ne compte donc jamais deux fois.
 * - L'auteur ne compte pas ses propres lectures. Un Short payant n'est mesuré que pour un achat confirmé.
 * N.B. Ces temps alimentent seulement les statistiques de rétention. Ils ne changent ni le comptage des vues,
 * ni l'éligibilité, ni la rémunération.
 */
export async function recordWatchBatch(user: User, shortId: string, sessions: WatchSession[]) {
  const row = await loadInteractive(user, 'SHORT', shortId);
  if (row.authorId === user.id) return { accepted: 0 };
  if (row.price != null) {
    const purchase = await prisma.paidContentPurchase.findUnique({
      where: { contentType_contentId_buyerId: { contentType: 'SHORT', contentId: shortId, buyerId: user.id } },
      select: { status: true },
    });
    if (purchase?.status !== 'PAID') return { accepted: 0 };
  }
  let accepted = 0;
  await prisma.$transaction(async (tx) => {
    for (const s of sessions) {
      await tx.shortWatchEvent.updateMany({
        where: { shortId, userId: user.id, clientSessionId: s.clientSessionId, watchedMs: { lt: s.watchedMs } },
        data: { watchedMs: s.watchedMs, completed: s.completed },
      });
    }
    const created = await tx.shortWatchEvent.createMany({
      data: sessions.map((s) => ({ shortId, userId: user.id, clientSessionId: s.clientSessionId, watchedMs: s.watchedMs, completed: s.completed })),
      skipDuplicates: true,
    });
    accepted = created.count;
  });
  return { accepted };
}

/** Rétention des Shorts du créateur connecté, sur une période. Agrégé uniquement : aucun identifiant de spectateur. */
export async function creatorShortRetention(user: User, range: RetentionRange) {
  const groups = await prisma.shortWatchEvent.groupBy({
    by: ['shortId', 'completed'],
    where: { createdAt: { gte: rangeStart(range) }, short: { authorId: user.id } },
    _count: { _all: true },
    _sum: { watchedMs: true },
  });
  const rows: GroupRow[] = groups.map((g) => ({ shortId: g.shortId, completed: g.completed, count: g._count._all, watchedMs: g._sum.watchedMs ?? 0 }));
  const aggs = foldRows(rows);
  const shorts = aggs.length
    ? await prisma.short.findMany({ where: { id: { in: aggs.map((a) => a.shortId) } }, select: { id: true, title: true, durationSeconds: true } })
    : [];
  return { range, ...summarizeRetention(aggs, shorts) };
}
