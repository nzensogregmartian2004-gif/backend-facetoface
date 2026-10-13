import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, notFound } from '../../utils/errors';

export const favoriteSchema = z.object({ userId: z.string().trim().min(1).max(64), favorite: z.boolean() }).strict();

/** Favoris d'appel du membre : personnes actives, sans lui-même. */
export async function listFavorites(viewer: User) {
  const rows = await prisma.callFavorite.findMany({
    where: { ownerId: viewer.id, target: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'desc' },
    select: { target: { select: { id: true, username: true, displayName: true } } },
  });
  return rows.map((r) => r.target);
}

/** Ajoute ou retire un favori d'appel. Seul le membre concerné est affecté. */
export async function setFavorite(viewer: User, userId: string, favorite: boolean) {
  if (userId === viewer.id) throw badRequest('SELF_FAVORITE', 'Vous ne pouvez pas vous ajouter vous-même');
  if (!favorite) {
    await prisma.callFavorite.deleteMany({ where: { ownerId: viewer.id, userId } });
    return { favorite: false };
  }
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!target || target.status !== 'ACTIVE') throw notFound('Utilisateur introuvable');
  await prisma.callFavorite.upsert({
    where: { ownerId_userId: { ownerId: viewer.id, userId } },
    create: { ownerId: viewer.id, userId },
    update: {},
  });
  return { favorite: true };
}

/** Efface le journal d'appels du membre : les appels sont seulement masqués pour lui. Rien n'est supprimé. */
export async function clearCallHistory(viewer: User) {
  const now = new Date();
  await prisma.call.updateMany({ where: { callerId: viewer.id, callerHiddenAt: null }, data: { callerHiddenAt: now } });
  await prisma.call.updateMany({ where: { calleeId: viewer.id, calleeHiddenAt: null }, data: { calleeHiddenAt: now } });
  return { cleared: true };
}
