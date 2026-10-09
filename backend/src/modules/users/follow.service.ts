import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, notFound } from '../../utils/errors';
import { notify } from '../notifications/notifications.service';

/**
 * Fondation minimale du suivi, nécessaire au feed « Abonnements » (étape 3).
 * Compteurs, listes d'abonnés/abonnements, recommandations et écrans : étape 4.
 */
async function requireFollowable(viewer: User, targetId: string) {
  if (targetId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Action impossible sur votre propre compte');
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, status: true } });
  if (!t || t.status !== 'ACTIVE') throw notFound('Utilisateur introuvable');
  const blocked = await prisma.block.findFirst({ where: { OR: [{ blockerId: viewer.id, blockedId: targetId }, { blockerId: targetId, blockedId: viewer.id }] }, select: { id: true } });
  if (blocked) throw notFound('Utilisateur introuvable'); // l'autre vous a bloqué (ou vous l'avez bloqué) : pas de suivi possible
}

export async function follow(viewer: User, targetId: string) {
  await requireFollowable(viewer, targetId);
  const result = await prisma.follow.createMany({ data: [{ followerId: viewer.id, followingId: targetId }], skipDuplicates: true });
  if (result.count === 1) await notify(prisma, { userId: targetId, type: 'FOLLOW', actorId: viewer.id, targetType: 'USER', targetId: viewer.id, pushPayload: { type: 'FOLLOW', username: viewer.username } });
}

export async function unfollow(viewer: User, targetId: string) {
  await prisma.follow.deleteMany({ where: { followerId: viewer.id, followingId: targetId } });
}
