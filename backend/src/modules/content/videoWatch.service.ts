import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { loadInteractive } from './access';
import { rangeStart, type RetentionRange } from './shortRetention.policy';
import { confirmCompletion, foldVideoRows, summarizeVideoWatch, type VideoWatchRow } from './videoWatch.policy';
import { getConfigValue } from '../config/config.service';

export type VideoWatchSession = { clientSessionId: string; watchedMs: number; completed: boolean };

/**
 * Reçoit un lot de sessions de lecture d'une vidéo longue (lot 2). Même règles que les Shorts :
 * une session est mise à jour si son temps a augmenté, un lot rejoué ne compte jamais deux fois,
 * l'auteur ne compte pas ses propres lectures, et un contenu payant n'est mesuré qu'après achat confirmé.
 */
export async function recordVideoWatchBatch(user: User, videoId: string, sessions: VideoWatchSession[]) {
  const row = await loadInteractive(user, 'VIDEO', videoId);
  if (row.authorId === user.id) return { accepted: 0 };
  if (row.price != null) {
    const purchase = await prisma.paidContentPurchase.findUnique({
      where: { contentType_contentId_buyerId: { contentType: 'VIDEO', contentId: videoId, buyerId: user.id } },
      select: { status: true },
    });
    if (purchase?.status !== 'PAID') return { accepted: 0 };
  }
  // Complétion confirmée par le serveur selon le seuil administrateur (VIDEOS.COMPLETION_PERCENT).
  const percent = (await getConfigValue<number>('VIDEOS.COMPLETION_PERCENT', 95)) ?? 95;
  const durationMs = (row.durationSeconds ?? 0) * 1000;
  const checked = sessions.map((s) => ({ ...s, completed: confirmCompletion(s.completed, s.watchedMs, durationMs, percent) }));
  let accepted = 0;
  await prisma.$transaction(async (tx) => {
    for (const s of checked) {
      await tx.videoWatchEvent.updateMany({
        where: { videoId, userId: user.id, clientSessionId: s.clientSessionId, watchedMs: { lt: s.watchedMs } },
        data: { watchedMs: s.watchedMs, completed: s.completed },
      });
    }
    const created = await tx.videoWatchEvent.createMany({
      data: checked.map((s) => ({ videoId, userId: user.id, clientSessionId: s.clientSessionId, watchedMs: s.watchedMs, completed: s.completed })),
      skipDuplicates: true,
    });
    accepted = created.count;
  });
  return { accepted };
}

/** Statistiques agrégées des vidéos longues du créateur connecté. Aucun identifiant de spectateur. */
export async function creatorVideoRetention(user: User, range: RetentionRange) {
  const groups = await prisma.videoWatchEvent.groupBy({
    by: ['videoId', 'completed'],
    where: { createdAt: { gte: rangeStart(range) }, video: { authorId: user.id } },
    _count: { _all: true },
    _sum: { watchedMs: true },
  });
  const rows: VideoWatchRow[] = groups.map((g) => ({ videoId: g.videoId, completed: g.completed, count: g._count._all, watchedMs: g._sum.watchedMs ?? 0 }));
  const aggs = foldVideoRows(rows);
  const videos = aggs.length
    ? await prisma.video.findMany({ where: { id: { in: aggs.map((a) => a.videoId) } }, select: { id: true, title: true, durationSeconds: true } })
    : [];
  return { range, ...summarizeVideoWatch(aggs, videos) };
}
