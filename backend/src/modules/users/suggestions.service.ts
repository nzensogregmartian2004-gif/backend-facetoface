import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { blockedIdsFor } from '../content/access';
import { repo } from '../content/types';
import { toUserCards } from './profile.service';
import { rankSuggestions, suggestionReason, suggestionScore, type SuggestionSignals } from './suggestions.ranking';

/**
 * Créateurs à suivre : actifs, ayant au moins un contenu public publié, ni vous, ni déjà suivis, ni bloqués (dans un sens ou l'autre).
 * Candidats = les plus suivis ∪ les plus suivis par vos propres abonnements ; classement par `suggestionScore`.
 */
export async function suggestCreators(viewer: User, limit: number) {
  const blocked = await blockedIdsFor(viewer.id);
  const follows = await prisma.follow.findMany({ where: { followerId: viewer.id }, select: { followingId: true }, take: 1000 });
  const followed = follows.map((f) => f.followingId);
  const excluded = [...new Set([viewer.id, ...blocked, ...followed])];
  const pub = { status: 'PUBLISHED' as const, visibility: 'PUBLIC' as const, deletedAt: null };
  const hasContent = { OR: [{ videos: { some: pub } }, { shorts: { some: pub } }] };

  // Amis d'amis : comptes suivis par ceux que je suis.
  const mutualRows = followed.length
    ? await prisma.follow.groupBy({ by: ['followingId'], where: { followerId: { in: followed }, followingId: { notIn: excluded }, following: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE', isCreator: true, ...hasContent } }, _count: { _all: true }, orderBy: { _count: { followingId: 'desc' } }, take: 50 })
    : [];
  const mutual = new Map(mutualRows.map((r) => [r.followingId, r._count?._all ?? 0]));

  const popular = await prisma.user.findMany({
    where: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE', isCreator: true, id: { notIn: excluded }, ...hasContent },
    orderBy: [{ followers: { _count: 'desc' } }, { id: 'asc' }],
    take: 100,
  });
  const extraIds = [...mutual.keys()].filter((id) => !popular.some((u) => u.id === id));
  const extra = extraIds.length ? await prisma.user.findMany({ where: { id: { in: extraIds } } }) : [];
  const candidates = [...popular, ...extra];
  if (candidates.length === 0) return { items: [] };
  const ids = candidates.map((u) => u.id);

  // Centres d'intérêt : catégories de mes derniers likes ∩ catégories publiées par le candidat.
  const likes = await prisma.like.findMany({ where: { userId: viewer.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { targetType: true, targetId: true } });
  const liked = new Set<string>();
  for (const kind of ['VIDEO', 'SHORT'] as const) {
    const t = likes.filter((l) => l.targetType === kind).map((l) => l.targetId);
    if (t.length) for (const r of (await repo(prisma, kind).findMany({ where: { id: { in: t } }, select: { category: true } })) as { category: string }[]) liked.add(r.category);
  }
  const cats = new Map<string, Set<string>>();
  if (liked.size) {
    const where = { authorId: { in: ids }, ...pub, category: { in: [...liked] } };
    const rows = [...await prisma.video.groupBy({ by: ['authorId', 'category'], where }), ...await prisma.short.groupBy({ by: ['authorId', 'category'], where })];
    for (const r of rows) (cats.get(r.authorId) ?? cats.set(r.authorId, new Set()).get(r.authorId)!).add(r.category);
  }

  const cards = await toUserCards(viewer, candidates);
  const enriched = cards.map((c) => {
    const signals: SuggestionSignals = { followers: c.followersCount ?? 0, mutual: mutual.get(c.id) ?? 0, affinity: cats.get(c.id)?.size ?? 0 };
    return { ...c, mutualCount: signals.mutual, reason: suggestionReason(signals), _s: signals };
  });
  return { items: rankSuggestions(enriched, (e) => suggestionScore(e._s)).slice(0, limit).map(({ _s, ...rest }) => rest) };
}
