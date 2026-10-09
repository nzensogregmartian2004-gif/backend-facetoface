import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { encodeCursor, idCursor, readIdCursor, readOffsetCursor } from '../../utils/cursor';
import { blockedIdsFor } from '../content/access';
import { PUBLIC_AUTHOR_SELECT, serializeMany } from '../content/content.serializer';
import { repo, type ContentWithAuthor, type Kind } from '../content/types';
import { rank, type Signals } from './ranking';
import { activeScoring } from './scoring';

export type FeedTab = 'for-you' | 'following' | 'trending';
const DAY = 86_400_000;

/** Filtre commun : contenu publié, public (les « non répertoriés » n'apparaissent jamais dans un feed), auteur actif, aucun blocage dans un sens ou l'autre. */
export function baseWhere(blocked: string[], extra: Record<string, unknown> = {}) {
  return {
    status: 'PUBLISHED', visibility: 'PUBLIC', deletedAt: null,
    author: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE' },
    ...(blocked.length ? { authorId: { notIn: blocked } } : {}),
    ...extra,
  };
}

/** « Abonnements » : publications des comptes suivis, du plus récent au plus ancien (pagination par curseur, stable). */
async function following(viewer: User, kind: Kind, o: { cursor?: string; limit: number }, blocked: string[]) {
  const cursorId = readIdCursor(o.cursor);
  const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: baseWhere(blocked, { author: { followers: { some: { followerId: viewer.id } } } }),
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const page = rows.slice(0, o.limit);
  return { items: await serializeMany(kind, page, viewer), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}

/** Signaux personnels pour « Pour toi » : abonnements, catégories des derniers likes, contenus vus cette semaine. */
async function signalsFor(viewer: User, kind: Kind, now: Date): Promise<Signals> {
  const [follows, likes, views] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: viewer.id }, select: { followingId: true }, take: 1000 }),
    prisma.like.findMany({ where: { userId: viewer.id, targetType: kind }, orderBy: { createdAt: 'desc' }, take: 50, select: { targetId: true } }),
    prisma.contentView.findMany({ where: { userId: viewer.id, targetType: kind, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } }, select: { targetId: true }, take: 1000 }),
  ]);
  const likedCategories = new Map<string, number>();
  if (likes.length) {
    const liked: { category: string }[] = await repo(prisma, kind).findMany({ where: { id: { in: likes.map((l) => l.targetId) } }, select: { category: true } });
    for (const c of liked) likedCategories.set(c.category, (likedCategories.get(c.category) ?? 0) + 1);
  }
  return { followedAuthors: new Set(follows.map((f) => f.followingId)), likedCategories, seen: new Set(views.map((v) => v.targetId)) };
}

/**
 * « Pour toi » et « Tendances » : on charge les `FEED_CANDIDATES` contenus récents les plus plausibles, on les classe en mémoire
 * (score pur, voir ranking.ts) puis on pagine par décalage. Le classement bouge dans le temps : deux pages consécutives peuvent
 * (rarement) se chevaucher. Le nombre de candidats reste volontairement borné par `FEED_CANDIDATES` pour maîtriser CPU et mémoire.
 */
async function ranked(viewer: User, kind: Kind, tab: 'for-you' | 'trending', o: { cursor?: string; limit: number }, blocked: string[]) {
  const now = new Date();
  const windowDays = tab === 'trending' ? 7 : 60;
  const offset = readOffsetCursor(o.cursor);
  const candidates: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: baseWhere([...blocked, viewer.id], { publishedAt: { gte: new Date(now.getTime() - windowDays * DAY) } }),
    orderBy: tab === 'trending'
      ? [{ viewCount: 'desc' }, { likeCount: 'desc' }, { id: 'desc' }] // les plus regardés de la période, puis classés par score
      : [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: env.FEED_CANDIDATES,
    include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const scoring = activeScoring();
  const score = tab === 'trending'
    ? (c: ContentWithAuthor) => scoring.trending({ ...c, publishedAt: c.publishedAt! }, now)
    : await (async () => { const s = await signalsFor(viewer, kind, now); return (c: ContentWithAuthor) => scoring.forYou({ ...c, publishedAt: c.publishedAt! }, now, s); })();
  const sorted = rank(candidates.map((c) => ({ ...c, publishedAt: c.publishedAt! })), score as never) as ContentWithAuthor[];
  const page = sorted.slice(offset, offset + o.limit);
  return { items: await serializeMany(kind, page, viewer), nextCursor: offset + o.limit < sorted.length ? encodeCursor({ o: offset + o.limit }) : null };
}

export async function getFeed(viewer: User, tab: FeedTab, kind: Kind, o: { cursor?: string; limit: number }) {
  const blocked = await blockedIdsFor(viewer.id);
  return tab === 'following' ? following(viewer, kind, o, blocked) : ranked(viewer, kind, tab, o, blocked);
}

/**
 * Feed local (étape 12) : contenus publiés de créateurs du pays demandé, classés par popularité (stratégie active).
 * Même pagination par décalage que « Tendances ».
 */
export async function getLocalFeed(viewer: User, kind: Kind, country: string, o: { cursor?: string; limit: number }) {
  const now = new Date();
  const blocked = await blockedIdsFor(viewer.id);
  const offset = readOffsetCursor(o.cursor);
  const candidates: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: {
      ...baseWhere([...blocked, viewer.id], { publishedAt: { gte: new Date(now.getTime() - 30 * DAY) } }),
      author: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE', country },
    },
    orderBy: [{ viewCount: 'desc' }, { id: 'desc' }],
    take: env.FEED_CANDIDATES,
    include: { author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  const scoring = activeScoring();
  const sorted = rank(candidates.map((c) => ({ ...c, publishedAt: c.publishedAt! })), (c) => scoring.trending(c, now)) as ContentWithAuthor[];
  const page = sorted.slice(offset, offset + o.limit);
  return { items: await serializeMany(kind, page, viewer), nextCursor: offset + o.limit < sorted.length ? encodeCursor({ o: offset + o.limit }) : null };
}

