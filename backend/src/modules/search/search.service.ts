import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { encodeCursor, readOffsetCursor } from '../../utils/cursor';
import { escapeLike } from '../../utils/like';
import { blockedIdsFor } from '../content/access';
import { PUBLIC_AUTHOR_SELECT, serializeMany } from '../content/content.serializer';
import { repo, type ContentWithAuthor, type Kind } from '../content/types';
import { toUserCards } from '../users/profile.service';
import type { SearchQuery } from './search.schemas';

const contains = (field: string, q: string) => ({ [field]: { contains: q, mode: 'insensitive' as const } });

async function searchPeople(viewer: User, q: SearchQuery, offset: number, blocked: string[]) {
  const text = escapeLike(q.q!);
  const rows = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      profileModerationStatus: 'ACTIVE',
      id: { notIn: [...blocked, viewer.id] },
      ...(q.type === 'creators' ? { isCreator: true } : {}),
      OR: [contains('username', text), contains('displayName', text)],
    },
    orderBy: q.sort === 'recent' ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ followers: { _count: 'desc' } }, { id: 'asc' }],
    skip: offset,
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return { items: await toUserCards(viewer, page), hasMore: rows.length > q.limit };
}

async function searchContent(viewer: User, q: SearchQuery, kind: Kind, offset: number, blocked: string[]) {
  const text = q.q ? escapeLike(q.q) : '';
  const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: {
      status: 'PUBLISHED', visibility: 'PUBLIC', deletedAt: null,
      author: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE' },
      ...(blocked.length ? { authorId: { notIn: blocked } } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(text ? { OR: [contains('title', text), contains('description', text), { author: contains('username', text) }, { author: contains('displayName', text) }] } : {}),
    },
    orderBy: q.sort === 'recent' ? [{ publishedAt: 'desc' }, { id: 'desc' }]
      : q.sort === 'views' ? [{ viewCount: 'desc' }, { id: 'desc' }]
      : [{ likeCount: 'desc' }, { viewCount: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: q.limit + 1,
    include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const page = rows.slice(0, q.limit);
  return { items: await serializeMany(kind, page, viewer), hasMore: rows.length > q.limit };
}

/**
 * Recherche : comptes (créateurs / tous), vidéos, Shorts. Exclut les blocages dans les deux sens, les comptes inactifs et tout
 * contenu non publié/non public. Les classements reposent sur des compteurs qui bouge : pagination par décalage (étape 25 : index texte).
 */
export async function search(viewer: User, q: SearchQuery) {
  const offset = readOffsetCursor(q.cursor);
  const blocked = await blockedIdsFor(viewer.id);
  const r = q.type === 'creators' || q.type === 'users' ? await searchPeople(viewer, q, offset, blocked) : await searchContent(viewer, q, q.type === 'shorts' ? 'SHORT' : 'VIDEO', offset, blocked);
  return { type: q.type, items: r.items, nextCursor: r.hasMore ? encodeCursor({ o: offset + q.limit }) : null };
}
