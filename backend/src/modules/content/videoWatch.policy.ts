/**
 * Statistiques de visionnage des vidéos longues (lot 2). Règles pures, sans base ni réseau.
 * Même principe que les Shorts : seuls des agrégats sont renvoyés, jamais l'identité des spectateurs.
 */
export type VideoWatchRow = { videoId: string; completed: boolean; count: number; watchedMs: number };
export type VideoWatchAgg = { videoId: string; sessions: number; completed: number; watchedMs: number };
export type VideoInfo = { id: string; title: string; durationSeconds: number | null };
export type VideoWatchTop = { videoId: string; title: string; sessions: number; avgWatchSeconds: number; completionRate: number; retention: number | null };
export type VideoWatchSummary = { sessions: number; avgWatchSeconds: number; completionRate: number; top: VideoWatchTop[] };

/** Regroupe les lignes SQL (une par vidéo et par état « terminé ») en un agrégat par vidéo. */
export function foldVideoRows(rows: VideoWatchRow[]): VideoWatchAgg[] {
  const byVideo = new Map<string, VideoWatchAgg>();
  for (const r of rows) {
    const a = byVideo.get(r.videoId) ?? { videoId: r.videoId, sessions: 0, completed: 0, watchedMs: 0 };
    a.sessions += r.count;
    if (r.completed) a.completed += r.count;
    a.watchedMs += r.watchedMs;
    byVideo.set(r.videoId, a);
  }
  return [...byVideo.values()];
}

/** Synthèse : temps moyen, taux de complétion, rétention moyenne (temps regardé / durée) et top des vidéos. */
export function summarizeVideoWatch(aggs: VideoWatchAgg[], infos: VideoInfo[], topN = 5): VideoWatchSummary {
  const byId = new Map(infos.map((i) => [i.id, i]));
  const sessions = aggs.reduce((n, a) => n + a.sessions, 0);
  const completed = aggs.reduce((n, a) => n + a.completed, 0);
  const watchedMs = aggs.reduce((n, a) => n + a.watchedMs, 0);
  const top = aggs
    .filter((a) => a.sessions > 0)
    .sort((x, y) => y.sessions - x.sessions)
    .slice(0, topN)
    .map((a) => {
      const info = byId.get(a.videoId);
      const avgWatchSeconds = a.watchedMs / a.sessions / 1000;
      const duration = info?.durationSeconds ?? 0;
      return {
        videoId: a.videoId,
        title: info?.title ?? '',
        sessions: a.sessions,
        avgWatchSeconds,
        completionRate: a.completed / a.sessions,
        retention: duration > 0 ? Math.min(1, avgWatchSeconds / duration) : null,
      };
    });
  return {
    sessions,
    avgWatchSeconds: sessions ? watchedMs / sessions / 1000 : 0,
    completionRate: sessions ? completed / sessions : 0,
    top,
  };
}

/**
 * Confirme la complétion côté serveur : le mobile la signale, mais elle n'est retenue que si le temps réellement
 * regardé atteint la part configurée de la durée. Empêche de gonfler la complétion par un envoi forgé.
 */
export function confirmCompletion(clientCompleted: boolean, watchedMs: number, durationMs: number, percent: number): boolean {
  if (!clientCompleted || durationMs <= 0) return false;
  return watchedMs >= durationMs * (percent / 100);
}
