/**
 * Classement du feed (pur, sans accès base : testable seul).
 * Principe : popularité pondérée qui décroît avec l'âge (type « gravité »), puis ajustements personnels pour « Pour toi »
 * (abonnements, catégories aimées, contenus déjà vus). Ces coefficients règlent la recommandation ; ce ne sont PAS des
 * paramètres économiques (aucune rémunération n'en dépend).
 */
export type RankInput = { id: string; authorId: string; category: string; publishedAt: Date; viewCount: number; likeCount: number; commentCount: number; shareCount: number };
export type Signals = { followedAuthors: ReadonlySet<string>; likedCategories: ReadonlyMap<string, number>; seen: ReadonlySet<string> };

export const WEIGHTS = {
  view: 1, like: 3, comment: 5, share: 4,
  gravity: 1.5, hoursOffset: 2,
  followedBoost: 1.5, categoryBoostPerLike: 0.05, categoryBoostCap: 0.5, seenPenalty: 0.2,
  freshnessHours: 24, freshnessBonus: 0.5,
} as const;

const HOUR = 3_600_000;
const ageHours = (d: Date, now: Date) => Math.max(0, (now.getTime() - d.getTime()) / HOUR);

export function trendingScore(i: RankInput, now: Date): number {
  const w = WEIGHTS;
  const engagement = i.viewCount * w.view + i.likeCount * w.like + i.commentCount * w.comment + i.shareCount * w.share;
  return (engagement + 1) / Math.pow(ageHours(i.publishedAt, now) + w.hoursOffset, w.gravity);
}

export function forYouScore(i: RankInput, now: Date, s: Signals): number {
  const w = WEIGHTS;
  const age = ageHours(i.publishedAt, now);
  let score = trendingScore(i, now);
  if (age < w.freshnessHours) score += w.freshnessBonus * (1 - age / w.freshnessHours); // laisse une chance aux nouveaux contenus
  if (s.followedAuthors.has(i.authorId)) score *= w.followedBoost;
  score *= 1 + Math.min(w.categoryBoostCap, (s.likedCategories.get(i.category) ?? 0) * w.categoryBoostPerLike);
  if (s.seen.has(i.id)) score *= w.seenPenalty;
  return score;
}

/** Tri décroissant par score, départage stable par identifiant. */
export function rank<T extends RankInput>(items: T[], score: (i: T) => number): T[] {
  return items
    .map((i) => ({ i, s: score(i) }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i.id < b.i.id ? 1 : -1))
    .map((x) => x.i);
}
