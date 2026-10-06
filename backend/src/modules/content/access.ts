import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { notFound } from '../../utils/errors';
import { repo, type ContentWithAuthor, type DbClient, type Kind } from './types';
import { hasActiveSubscription } from '../subscriptions/subscriptions.service';

/** Identifiants des utilisateurs bloqués par `userId` ou qui l'ont bloqué (le blocage s'applique dans les deux sens pour le feed et les commentaires). */
export async function blockedIdsFor(userId: string, db: DbClient = prisma): Promise<string[]> {
  const rows = await db.block.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } });
  return [...new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)))];
}

/**
 * Contenu consultable par `viewer`, sinon 404 (jamais 403 : on ne révèle pas l'existence d'un contenu privé).
 * - le propriétaire voit tout sauf le contenu supprimé ;
 * - les autres : publié, public ou non répertorié, auteur actif, auteur ne les ayant pas bloqués.
 */
export async function loadVisible(viewer: User, kind: Kind, id: string): Promise<ContentWithAuthor> {
  const row: ContentWithAuthor | null = await repo(prisma, kind).findUnique({ where: { id }, include: { author: true } });
  if (!row || row.status === 'REMOVED' || row.author.status !== 'ACTIVE' || row.author.profileModerationStatus !== 'ACTIVE') throw notFound('Contenu introuvable');
  if (row.authorId === viewer.id) return row;
  if (row.status !== 'PUBLISHED' || row.visibility === 'PRIVATE') throw notFound('Contenu introuvable');
  if (row.subscriptionOnly && !(await hasActiveSubscription(viewer.id, row.authorId))) throw notFound('Contenu introuvable');
  const blocked = await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: row.authorId, blockedId: viewer.id } } });
  if (blocked) throw notFound('Contenu introuvable');
  return row;
}

/** Contenu appartenant à `owner` (404 sinon, y compris pour le contenu d'un autre). */
export async function loadOwned(owner: User, kind: Kind, id: string): Promise<ContentWithAuthor> {
  const row: ContentWithAuthor | null = await repo(prisma, kind).findUnique({ where: { id }, include: { author: true } });
  if (!row || row.authorId !== owner.id || row.status === 'REMOVED') throw notFound('Contenu introuvable');
  return row;
}

/** Comme `loadVisible`, mais exige en plus un contenu PUBLIÉ (likes, vues, partages et commentaires n'ont pas de sens sur un brouillon). */
export async function loadInteractive(viewer: User, kind: Kind, id: string): Promise<ContentWithAuthor> {
  const row = await loadVisible(viewer, kind, id);
  if (row.status !== 'PUBLISHED') throw notFound('Contenu introuvable');
  return row;
}
