import { describe, expect, it } from 'vitest';
import { foldRows, rangeStart, shortRetention, summarizeRetention } from '../src/modules/content/shortRetention.policy';
import { watchBatchSchema, retentionQuerySchema } from '../src/modules/content/content.schemas';

const NOW = Date.parse('2026-10-08T12:00:00Z');

describe('étape 11 — agrégation de la rétention des Shorts', () => {
  it('fusionne les lignes par Short et compte les complétions', () => {
    const aggs = foldRows([
      { shortId: 'A', completed: false, count: 3, watchedMs: 15_000 },
      { shortId: 'A', completed: true, count: 1, watchedMs: 25_000 },
      { shortId: 'B', completed: false, count: 1, watchedMs: 12_000 },
    ]);
    expect(aggs.find((a) => a.shortId === 'A')).toEqual({ shortId: 'A', sessions: 4, completed: 1, watchedMs: 40_000 });
  });

  it('jeu de test : durée moyenne, complétion et rétention pondérée', () => {
    const aggs = foldRows([
      { shortId: 'A', completed: false, count: 3, watchedMs: 30_000 },
      { shortId: 'A', completed: true, count: 1, watchedMs: 10_000 },
      { shortId: 'B', completed: true, count: 1, watchedMs: 12_000 },
    ]);
    const s = summarizeRetention(aggs, [
      { id: 'A', title: 'Court A', durationSeconds: 20 },
      { id: 'B', title: 'Court B', durationSeconds: 10 },
    ]);
    expect(s.sessions).toBe(5);
    expect(s.avgWatchSeconds).toBeCloseTo(52 / 5, 5);
    expect(s.completionRate).toBeCloseTo(2 / 5, 5);
    // A : 40 s / 4 lectures = 10 s sur 20 s → 0,5 (4 lectures). B : 12 s sur 10 s → plafonné à 1 (1 lecture).
    expect(s.avgRetention).toBeCloseTo((0.5 * 4 + 1 * 1) / 5, 5);
    expect(s.top.map((t) => t.title)).toEqual(['Court A', 'Court B']);
    expect(s.top[0].retention).toBeCloseTo(0.5, 5);
    expect(s.top[1].retention).toBe(1);
  });

  it('sans lecture : tout à zéro, sans division par zéro', () => {
    const s = summarizeRetention([], []);
    expect(s).toEqual({ sessions: 0, avgWatchSeconds: 0, completionRate: 0, avgRetention: 0, top: [] });
  });

  it('durée inconnue : pas de rétention pour ce Short, mais ses lectures comptent', () => {
    const aggs = foldRows([{ shortId: 'C', completed: false, count: 2, watchedMs: 8_000 }]);
    const s = summarizeRetention(aggs, [{ id: 'C', title: 'Sans durée', durationSeconds: null }]);
    expect(s.sessions).toBe(2);
    expect(s.avgRetention).toBe(0);
    expect(shortRetention(aggs[0], null)).toBeNull();
  });

  it('période : 7, 30 ou 90 jours', () => {
    expect(rangeStart('7d', NOW).getTime()).toBe(NOW - 7 * 86_400_000);
    expect(rangeStart('90d', NOW).getTime()).toBe(NOW - 90 * 86_400_000);
  });
});

describe('étape 11 — validation des lots reçus', () => {
  const session = { clientSessionId: 'abc12345-xyz', watchedMs: 12_000, completed: false };
  it('accepte un lot valide', () => {
    expect(watchBatchSchema.safeParse({ sessions: [session] }).success).toBe(true);
  });
  it('refuse un lot vide ou de plus de 50 sessions', () => {
    expect(watchBatchSchema.safeParse({ sessions: [] }).success).toBe(false);
    expect(watchBatchSchema.safeParse({ sessions: Array.from({ length: 51 }, () => session) }).success).toBe(false);
  });
  it('refuse une session de plus de 5 minutes, un temps négatif, ou un identifiant mal formé', () => {
    expect(watchBatchSchema.safeParse({ sessions: [{ ...session, watchedMs: 300_001 }] }).success).toBe(false);
    expect(watchBatchSchema.safeParse({ sessions: [{ ...session, watchedMs: -1 }] }).success).toBe(false);
    expect(watchBatchSchema.safeParse({ sessions: [{ ...session, clientSessionId: 'a b/c d e f' }] }).success).toBe(false);
  });
  it('refuse les champs inconnus', () => {
    expect(watchBatchSchema.safeParse({ sessions: [{ ...session, userId: 'x' }] }).success).toBe(false);
  });
  it('période par défaut : 30 jours ; valeurs inconnues refusées', () => {
    expect(retentionQuerySchema.parse({}).range).toBe('30d');
    expect(retentionQuerySchema.safeParse({ range: '12m' }).success).toBe(false);
  });
});
