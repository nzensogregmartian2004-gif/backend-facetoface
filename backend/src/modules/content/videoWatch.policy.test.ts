import { describe, expect, it } from 'vitest';
import { confirmCompletion, foldVideoRows, summarizeVideoWatch } from './videoWatch.policy';

describe('statistiques de visionnage des vidéos longues', () => {
  it('additionne les sessions et les temps par vidéo', () => {
    const aggs = foldVideoRows([
      { videoId: 'v1', completed: false, count: 3, watchedMs: 60_000 },
      { videoId: 'v1', completed: true, count: 1, watchedMs: 120_000 },
      { videoId: 'v2', completed: false, count: 2, watchedMs: 20_000 },
    ]);
    const v1 = aggs.find((a) => a.videoId === 'v1')!;
    expect(v1).toEqual({ videoId: 'v1', sessions: 4, completed: 1, watchedMs: 180_000 });
  });

  it('calcule le taux de complétion, le temps moyen et la rétention', () => {
    const aggs = foldVideoRows([
      { videoId: 'v1', completed: true, count: 1, watchedMs: 600_000 },
      { videoId: 'v1', completed: false, count: 1, watchedMs: 200_000 },
    ]);
    const s = summarizeVideoWatch(aggs, [{ id: 'v1', title: 'Cours', durationSeconds: 800 }]);
    expect(s.sessions).toBe(2);
    expect(s.completionRate).toBe(0.5);
    expect(s.avgWatchSeconds).toBe(400);
    expect(s.top[0].retention).toBe(0.5);
  });

  it('ne divise jamais par zéro et ignore la rétention sans durée connue', () => {
    const s = summarizeVideoWatch([], []);
    expect(s).toEqual({ sessions: 0, avgWatchSeconds: 0, completionRate: 0, top: [] });
    const t = summarizeVideoWatch(foldVideoRows([{ videoId: 'v9', completed: false, count: 1, watchedMs: 5000 }]), [{ id: 'v9', title: 'X', durationSeconds: null }]);
    expect(t.top[0].retention).toBeNull();
  });
});

describe('confirmation de la complétion', () => {
  it('exige que le temps regardé atteigne le seuil de la durée', () => {
    expect(confirmCompletion(true, 950_000, 1_000_000, 95)).toBe(true);
    expect(confirmCompletion(true, 900_000, 1_000_000, 95)).toBe(false);
  });
  it('refuse une complétion signalée sans lecture suffisante, ou sans durée connue', () => {
    expect(confirmCompletion(false, 1_000_000, 1_000_000, 95)).toBe(false);
    expect(confirmCompletion(true, 1_000_000, 0, 95)).toBe(false);
  });
});

