import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { blockedIdsFor } from '../content/access';
import { PUBLIC_AUTHOR_SELECT, serializeMany } from '../content/content.serializer';
import { repo, type ContentWithAuthor, type Kind } from '../content/types';
import { baseWhere } from '../feed/feed.service';
import { toUserCards } from '../users/profile.service';

const WEEK = 7 * 86_400_000;

/** Recherche de hashtags : préfixe du texte saisi, classés par nombre de contenus. Sans texte : tendances de la semaine. */
export async function searchHashtags(q: string | undefined, limit: number) {
  if (!q) {
    const groups = await prisma.contentHashtag.groupBy({
      by: ['hashtagId'], where: { createdAt: { gte: new Date(Date.now() - WEEK) } },
      _count: { _all: true }, orderBy: { _count: { hashtagId: 'desc' } }, take: limit,
    });
    const names = await prisma.hashtag.findMany({ where: { id: { in: groups.map((g) => g.hashtagId) } }, select: { id: true, name: true } });
    const byId = new Map(names.map((n) => [n.id, n.name] as const));
    return { items: groups.map((g) => ({ name: byId.get(g.hashtagId) ?? '', count: g._count._all })).filter((x) => x.name), mode: 'trending' as const };
  }
  const rows = await prisma.hashtag.findMany({
    where: { name: { startsWith: q } },
    orderBy: [{ contents: { _count: 'desc' } }, { name: 'asc' }],
    take: limit,
    select: { name: true, _count: { select: { contents: true } } },
  });
  return { items: rows.map((r) => ({ name: r.name, count: r._count.contents })), mode: 'search' as const };
}

/** Contenus publiés portant un hashtag, du plus récent au plus ancien (curseur sur le lien hashtag → contenu). */
export async function hashtagContents(viewer: User, tag: string, kind: Kind, o: { cursor?: string; limit: number }) {
  const hashtag = await prisma.hashtag.findUnique({ where: { name: tag }, select: { id: true, name: true } });
  if (!hashtag) return { hashtag: { name: tag, count: 0 }, items: [], nextCursor: null };
  const cursorId = readIdCursor(o.cursor);
  const links = await prisma.contentHashtag.findMany({
    where: { hashtagId: hashtag.id, contentType: kind },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: { id: true, contentId: true },
  });
  const page = links.slice(0, o.limit);
  const blocked = await blockedIdsFor(viewer.id);
  const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: { ...baseWhere([...blocked, viewer.id]), id: { in: page.map((l) => l.contentId) } },
    include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const ordered = page.map((l) => byId.get(l.contentId)).filter((r): r is ContentWithAuthor => !!r);
  const count = await prisma.contentHashtag.count({ where: { hashtagId: hashtag.id, contentType: kind } });
  return {
    hashtag: { name: hashtag.name, count },
    items: await serializeMany(kind, ordered, viewer),
    nextCursor: links.length > o.limit ? idCursor(page[page.length - 1].id) : null,
  };
}

/** Créateurs populaires (par nombre d'abonnés), éventuellement limités à un pays. Profils publics seulement. */
export async function popularCreators(viewer: User, o: { country?: string; limit: number }) {
  const blocked = await blockedIdsFor(viewer.id);
  const rows = await prisma.user.findMany({
    where: {
      isCreator: true, status: 'ACTIVE', profileModerationStatus: 'ACTIVE', profileVisibility: 'PUBLIC',
      id: { notIn: [...blocked, viewer.id] },
      ...(o.country ? { country: o.country } : {}),
    },
    orderBy: [{ followers: { _count: 'desc' } }, { id: 'asc' }],
    take: o.limit,
  });
  return toUserCards(viewer, rows);
}

