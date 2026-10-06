import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { idCursor, readIdCursor, readOffsetCursor, encodeCursor } from '../../utils/cursor';
import { forbidden, notFound } from '../../utils/errors';
import { serializePublic } from '../../utils/serializers';
import { messagingPermission } from '../messages/permission';
import { blockedIdsFor } from '../content/access';
import { PUBLIC_AUTHOR_SELECT, serializeMany } from '../content/content.serializer';
import { repo, type ContentWithAuthor, type Kind } from '../content/types';

/** Contenu publiquement visible d'un auteur (même filtre que les feeds, hors blocage). */
export const publicContentWhere = (authorId: string) => ({ authorId, status: 'PUBLISHED' as const, visibility: 'PUBLIC' as const, deletedAt: null });

/**
 * Résout `:username` (ou l'alias `me`) en utilisateur consultable par `viewer`.
 * 404 si inconnu, supprimé/suspendu/banni, ou si cet utilisateur a bloqué `viewer`. Retourne aussi si `viewer` l'a bloqué.
 */
export async function resolveProfile(viewer: User, username: string): Promise<{ target: User; isSelf: boolean; blockedByMe: boolean }> {
  if (username === 'me') return { target: viewer, isSelf: true, blockedByMe: false };
  const target = await prisma.user.findUnique({ where: { username } });
  if (!target || target.status !== 'ACTIVE' || target.profileModerationStatus !== 'ACTIVE') throw notFound('Profil introuvable');
  if (target.id === viewer.id) return { target, isSelf: true, blockedByMe: false };
  const [byTarget, mine] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: target.id, blockedId: viewer.id } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: viewer.id, blockedId: target.id } } }),
  ]);
  if (byTarget) throw notFound('Profil introuvable');
  return { target, isSelf: false, blockedByMe: !!mine };
}

/** Un profil privé masque aux autres : bio/pays/liens (étape 2), compteurs d'abonnés/abonnements et leurs listes (étape 4). Le contenu public reste visible : sa visibilité est décidée contenu par contenu. */
export const listsHidden = (target: User, isSelf: boolean) => target.profileVisibility === 'PRIVATE' && !isSelf;

export async function followerCount(userId: string) {
  return prisma.follow.count({ where: { followingId: userId, follower: { status: 'ACTIVE' } } });
}
export async function followingCount(userId: string) {
  return prisma.follow.count({ where: { followerId: userId, following: { status: 'ACTIVE' } } });
}

/** Nombre d'abonnés actifs pour plusieurs utilisateurs (une seule requête). */
export async function followerCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.follow.groupBy({ by: ['followingId'], where: { followingId: { in: ids }, follower: { status: 'ACTIVE' } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.followingId, r._count._all]));
}

/** Profil public enrichi : compteurs, statistiques publiques, état de la relation avec le spectateur. */
export async function getProfile(viewer: User, username: string) {
  const { target, isSelf, blockedByMe } = await resolveProfile(viewer, username);
  const where = publicContentWhere(target.id);
  const hidden = listsHidden(target, isSelf);
  const [followers, following, videos, shorts, iFollow, followsMe, messagePermission] = await Promise.all([
    hidden ? null : followerCount(target.id),
    hidden ? null : followingCount(target.id),
    prisma.video.aggregate({ where, _count: { id: true }, _sum: { viewCount: true, likeCount: true } }),
    prisma.short.aggregate({ where, _count: { id: true }, _sum: { viewCount: true, likeCount: true } }),
    isSelf ? null : prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer.id, followingId: target.id } }, select: { id: true } }),
    isSelf ? null : prisma.follow.findUnique({ where: { followerId_followingId: { followerId: target.id, followingId: viewer.id } }, select: { id: true } }),
    isSelf ? { allowed: true } : messagingPermission(viewer, target),
  ]);
  return {
    ...serializePublic(target, { blockedByMe }),
    counts: {
      followers, following,
      videos: videos._count.id,
      shorts: shorts._count.id,
      views: (videos._sum.viewCount ?? 0) + (shorts._sum.viewCount ?? 0),
      likes: (videos._sum.likeCount ?? 0) + (shorts._sum.likeCount ?? 0),
    },
    creator: target.isCreator ? { since: target.creatorActivatedAt } : null,
    viewer: { isSelf, isFollowing: !!iFollow, followsMe: !!followsMe, canMessage: !!messagePermission.allowed },
  };
}

export type UserCard = ReturnType<typeof serializePublic> & { followersCount: number | null; viewer: { isSelf: boolean; isFollowing: boolean; followsMe: boolean; canMessage: boolean } };

/** Cartes utilisateur (listes, recherche, suggestions) : `serializePublic` + nombre d'abonnés + relation avec le spectateur, en 3 requêtes groupées. */
export async function toUserCards(viewer: User, users: User[]): Promise<UserCard[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);
  const [counts, mine, theirs] = await Promise.all([
    followerCounts(ids),
    prisma.follow.findMany({ where: { followerId: viewer.id, followingId: { in: ids } }, select: { followingId: true } }),
    prisma.follow.findMany({ where: { followingId: viewer.id, followerId: { in: ids } }, select: { followerId: true } }),
  ]);
  const iFollow = new Set(mine.map((f) => f.followingId));
  const followMe = new Set(theirs.map((f) => f.followerId));
  return Promise.all(users.map(async (u) => {
    const permission = u.id === viewer.id ? { allowed: true } : await messagingPermission(viewer, u);
    return {
      ...serializePublic(u),
      followersCount: u.profileVisibility === 'PRIVATE' && u.id !== viewer.id ? null : counts.get(u.id) ?? 0,
      viewer: { isSelf: u.id === viewer.id, isFollowing: iFollow.has(u.id), followsMe: followMe.has(u.id), canMessage: permission.allowed },
    };
  }));
}

/** Abonnés (`followers`) ou abonnements (`following`) d'un utilisateur, du plus récent au plus ancien, par curseur. */
export async function listRelations(viewer: User, username: string, dir: 'followers' | 'following', o: { cursor?: string; limit: number }) {
  const { target, isSelf, blockedByMe } = await resolveProfile(viewer, username);
  if (listsHidden(target, isSelf)) throw forbidden('PROFILE_PRIVATE', 'Cette liste est privée');
  if (blockedByMe) return { items: [], nextCursor: null };
  const blocked = await blockedIdsFor(viewer.id);
  const cursorId = readIdCursor(o.cursor);
  const other = dir === 'followers' ? 'follower' : 'following';
  const rows = await prisma.follow.findMany({
    where: dir === 'followers'
      ? { followingId: target.id, follower: { status: 'ACTIVE', id: { notIn: blocked } } }
      : { followerId: target.id, following: { status: 'ACTIVE', id: { notIn: blocked } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { follower: true, following: true },
  });
  const page = rows.slice(0, o.limit);
  const cards = await toUserCards(viewer, page.map((r) => r[other]));
  return { items: cards.map((c, i) => ({ ...c, followedAt: page[i].createdAt })), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}

/** Vidéos ou Shorts publics d'un profil. `recent` : curseur stable ; `popular` : classés par vues, pagination par décalage. */
export async function listProfileContent(viewer: User, username: string, kind: Kind, o: { cursor?: string; limit: number; sort: 'recent' | 'popular' }) {
  const { target, blockedByMe } = await resolveProfile(viewer, username);
  if (blockedByMe) return { items: [], nextCursor: null };
  const where = publicContentWhere(target.id);
  if (o.sort === 'popular') {
    const offset = readOffsetCursor(o.cursor);
    const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({ where, orderBy: [{ viewCount: 'desc' }, { likeCount: 'desc' }, { id: 'desc' }], skip: offset, take: o.limit + 1, include: { author: { select: PUBLIC_AUTHOR_SELECT } } });
    const page = rows.slice(0, o.limit);
    return { items: await serializeMany(kind, page, viewer), nextCursor: rows.length > o.limit ? encodeCursor({ o: offset + o.limit }) : null };
  }
  const cursorId = readIdCursor(o.cursor);
  const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}), include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const page = rows.slice(0, o.limit);
  return { items: await serializeMany(kind, page, viewer), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}
