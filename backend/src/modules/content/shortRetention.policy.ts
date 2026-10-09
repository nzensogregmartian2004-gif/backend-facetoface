/**
 * Rétention des Shorts (étape 11) : règles pures d'agrégation. Aucune dépendance : testables sans base.
 * Les chiffres ne contiennent jamais d'identité de spectateur.
 */

export const RETENTION_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type RetentionRange = keyof typeof RETENTION_DAYS;

export function rangeStart(range: RetentionRange, now: number = Date.now()): Date {
  return new Date(now - RETENTION_DAYS[range] * 86_400_000);
}

/** Ligne d'un regroupement Prisma par (Short, complété). */
export type GroupRow = { shortId: string; completed: boolean; count: number; watchedMs: number };
/** Total par Short, toutes complétions confondues. */
export type ShortAgg = { shortId: string; sessions: number; completed: number; watchedMs: number };
export type ShortInfo = { id: string; title: string; durationSeconds: number | null };
export type RetentionTop = { shortId: string; title: string; sessions: number; avgWatchSeconds: number; completionRate: number; retention: number };
export type RetentionSummary = {
  sessions: number;
  avgWatchSeconds: number;
  completionRate: number;
  /** Part moyenne de chaque Short regardée, plafonnée à 100 % par Short, pondérée par le nombre de lectures. */
  avgRetention: number;
  top: RetentionTop[];
};

export function foldRows(rows: GroupRow[]): ShortAgg[] {
  const by = new Map<string, ShortAgg>();
  for (const r of rows) {
    const agg = by.get(r.shortId) ?? { shortId: r.shortId, sessions: 0, completed: 0, watchedMs: 0 };
    agg.sessions += r.count;
    agg.watchedMs += r.watchedMs;
    if (r.completed) agg.completed += r.count;
    by.set(r.shortId, agg);
  }
  return [...by.values()];
}

/** Retention d'un Short : temps moyen par lecture / durée, plafonné à 1. Null si la durée est inconnue. */
export function shortRetention(agg: ShortAgg, durationSeconds: number | null): number | null {
  if (!durationSeconds || durationSeconds <= 0 || agg.sessions === 0) return null;
  const avgMs = agg.watchedMs / agg.sessions;
  return Math.min(1, avgMs / (durationSeconds * 1000));
}

export function summarizeRetention(aggs: ShortAgg[], infos: ShortInfo[], topN = 5): RetentionSummary {
  const info = new Map(infos.map((i) => [i.id, i] as const));
  const sessions = aggs.reduce((n, a) => n + a.sessions, 0);
  const watchedMs = aggs.reduce((n, a) => n + a.watchedMs, 0);
  const completed = aggs.reduce((n, a) => n + a.completed, 0);

  let weighted = 0;
  let weight = 0;
  for (const a of aggs) {
    const r = shortRetention(a, info.get(a.shortId)?.durationSeconds ?? null);
    if (r === null) continue;
    weighted += r * a.sessions;
    weight += a.sessions;
  }

  const top: RetentionTop[] = aggs
    .filter((a) => info.has(a.shortId))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, topN)
    .map((a) => ({
      shortId: a.shortId,
      title: info.get(a.shortId)!.title,
      sessions: a.sessions,
      avgWatchSeconds: a.sessions ? a.watchedMs / a.sessions / 1000 : 0,
      completionRate: a.sessions ? a.completed / a.sessions : 0,
      retention: shortRetention(a, info.get(a.shortId)!.durationSeconds) ?? 0,
    }));

  return {
    sessions,
    avgWatchSeconds: sessions ? watchedMs / sessions / 1000 : 0,
    completionRate: sessions ? completed / sessions : 0,
    avgRetention: weight ? weighted / weight : 0,
    top,
  };
}
