import { afterEach, describe, expect, it } from 'vitest';
import { WEIGHTS, forYouScore, trendingScore, type RankInput } from '../src/modules/feed/ranking';
import { activeScoring, defaultScoring, resetScoring, setScoring, type ScoringStrategy } from '../src/modules/feed/scoring';

const NOW = new Date('2026-10-08T12:00:00Z');
const item: RankInput = { id: 'a', authorId: 'u', category: 'Musique', publishedAt: new Date(NOW.getTime() - 3 * 3_600_000), viewCount: 100, likeCount: 10, commentCount: 2, shareCount: 1 };

describe('étape 12 — interface de classement remplaçable', () => {
  afterEach(() => resetScoring());

  it('la stratégie par défaut reproduit exactement le classement actuel', () => {
    expect(activeScoring().name).toBe('gravite-v1');
    expect(defaultScoring.trending(item, NOW)).toBe(trendingScore(item, NOW));
    const signals = { followedAuthors: new Set<string>(), likedCategories: new Map<string, number>(), seen: new Set<string>() };
    expect(defaultScoring.forYou(item, NOW, signals)).toBe(forYouScore(item, NOW, signals));
    expect(WEIGHTS.gravity).toBe(1.5);
  });

  it('une autre stratégie se branche sans toucher aux appelants', () => {
    const custom: ScoringStrategy = { name: 'vues-seules', trending: (i) => i.viewCount, forYou: (i) => i.viewCount };
    setScoring(custom);
    expect(activeScoring().name).toBe('vues-seules');
    expect(activeScoring().trending(item, NOW)).toBe(100);
  });
});
