import type { Comment, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { forbidden, notFound } from '../../utils/errors';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { serializePublic } from '../../utils/serializers';
import { blockedIdsFor, loadInteractive } from '../content/access';
import { repo, type Kind } from '../content/types';

type CommentWithAuthor = Comment & { author: User };

const serialize = (c: CommentWithAuthor, viewer: User, contentOwnerId: string) => ({
  id: c.id,
  text: c.text,
  createdAt: c.createdAt,
  author: serializePublic(c.author),
  canDelete: c.authorId === viewer.id || contentOwnerId === viewer.id,
});

/** Commentaires du plus récent au plus ancien. Les commentaires d'utilisateurs bloqués (dans un sens ou dans l'autre) sont masqués. */
export async function list(viewer: User, kind: Kind, id: string, o: { cursor?: string; limit: number }) {
  const content = await loadInteractive(viewer, kind, id);
  if (!content.allowComments) return { items: [], nextCursor: null, allowComments: false };
  const blocked = await blockedIdsFor(viewer.id);
  const cursorId = readIdCursor(o.cursor);
  const rows: CommentWithAuthor[] = await prisma.comment.findMany({
    where: { targetType: kind, targetId: id, deletedAt: null, moderationStatus: 'ACTIVE', author: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE' }, ...(blocked.length ? { authorId: { notIn: blocked } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: true },
  });
  const page = rows.slice(0, o.limit);
  return { items: page.map((c) => serialize(c, viewer, content.authorId)), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null, allowComments: true };
}

export async function create(viewer: User, kind: Kind, id: string, text: string) {
  const content = await loadInteractive(viewer, kind, id); // 404 si l'auteur vous a bloqué
  if (!content.allowComments) throw forbidden('COMMENTS_DISABLED', 'Les commentaires sont désactivés sur ce contenu');
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.comment.create({ data: { authorId: viewer.id, targetType: kind, targetId: id, text }, include: { author: true } });
    await repo(tx, kind).update({ where: { id }, data: { commentCount: { increment: 1 } } });
    return c;
  });
  return serialize(created, viewer, content.authorId);
}

/** Suppression douce, par l'auteur du commentaire ou par le propriétaire du contenu. Un tiers reçoit 404 (pas de fuite d'existence). */
export async function remove(viewer: User, commentId: string) {
  const c = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!c || c.deletedAt) throw notFound('Commentaire introuvable');
  const kind = c.targetType as Kind;
  const content = await repo(prisma, kind).findUnique({ where: { id: c.targetId }, select: { authorId: true } });
  const isOwner = content?.authorId === viewer.id;
  if (c.authorId !== viewer.id && !isOwner) throw notFound('Commentaire introuvable');
  await prisma.$transaction(async (tx) => {
    const r = await tx.comment.updateMany({ where: { id: commentId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count === 1 && content) await repo(tx, kind).update({ where: { id: c.targetId }, data: { commentCount: { decrement: 1 } } });
  });
}
