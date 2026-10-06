import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { forbidden } from '../../utils/errors';
import { loadInteractive } from './access';
import { shareUrl } from './content.serializer';
import { assessActivity } from '../fraud/fraud.service';
import { repo, type Kind } from './types';

const counter = async (kind: Kind, id: string, field: 'likeCount' | 'viewCount' | 'shareCount' | 'commentCount') => {
  const r = await repo(prisma, kind).findUnique({ where: { id }, select: { [field]: true } });
  return (r?.[field] ?? 0) as number;
};

export async function like(user: User, kind: Kind, id: string) {
  await loadInteractive(user, kind, id);
  await prisma.$transaction(async (tx) => {
    const r = await tx.like.createMany({ data: [{ userId: user.id, targetType: kind, targetId: id }], skipDuplicates: true });
    if (r.count === 1) await repo(tx, kind).update({ where: { id }, data: { likeCount: { increment: 1 } } });
  });
  return { liked: true, likeCount: await counter(kind, id, 'likeCount') };
}

export async function unlike(user: User, kind: Kind, id: string) {
  await loadInteractive(user, kind, id);
  await prisma.$transaction(async (tx) => {
    const r = await tx.like.deleteMany({ where: { userId: user.id, targetType: kind, targetId: id } });
    if (r.count === 1) await repo(tx, kind).update({ where: { id }, data: { likeCount: { decrement: 1 } } });
  });
  return { liked: false, likeCount: await counter(kind, id, 'likeCount') };
}

/**
 * Compte une vue : une par utilisateur et par fenêtre `VIEW_DEDUP_HOURS`, jamais pour l'auteur.
 * C'est un compteur d'AUDIENCE, pas une vue « qualifiée » (étape 8/9) : aucune rémunération n'en dépend à ce stade.
 */
export async function recordView(user: User, kind: Kind, id: string, watchedSeconds = 0, context: { ip?: string; userAgent?: string } = {}) {
  const row = await loadInteractive(user, kind, id);
  if (row.authorId === user.id) return { counted: false, viewCount: row.viewCount };
  const risk = await assessActivity(user.id, 'VIEW', context, { watchedSeconds, contentDurationSeconds: row.durationSeconds });
  if (risk.decision !== 'ALLOW') return { counted: false, viewCount: row.viewCount, excluded: true, reason: risk.reason };
  const since = new Date(Date.now() - env.VIEW_DEDUP_HOURS * 3_600_000);
  const recent = await prisma.contentView.findFirst({ where: { userId: user.id, targetType: kind, targetId: id, createdAt: { gte: since } }, select: { id: true } });
  if (recent) {
    if (watchedSeconds > 0) await prisma.contentView.updateMany({ where: { id: recent.id, watchedSeconds: { lt: watchedSeconds } }, data: { watchedSeconds } });
    return { counted: false, viewCount: row.viewCount };
  }
  await prisma.$transaction(async (tx) => {
    await tx.contentView.create({ data: { userId: user.id, targetType: kind, targetId: id, watchedSeconds } });
    await repo(tx, kind).update({ where: { id }, data: { viewCount: { increment: 1 } } });
  });
  return { counted: true, viewCount: await counter(kind, id, 'viewCount') };
}

export async function share(user: User, kind: Kind, id: string) {
  const row = await loadInteractive(user, kind, id);
  if (row.visibility === 'PRIVATE') throw forbidden('SHARE_NOT_ALLOWED', 'Un contenu privé ne peut pas être partagé');
  await repo(prisma, kind).update({ where: { id }, data: { shareCount: { increment: 1 } } });
  return { shareCount: await counter(kind, id, 'shareCount'), shareUrl: shareUrl(kind, id) };
}
