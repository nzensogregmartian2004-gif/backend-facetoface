/** Règles de fenêtre d'un appel planifié : au moins 10 minutes à l'avance, 60 jours au plus, durée 5 à 120 minutes. */
export const MIN_LEAD_MS = 10 * 60 * 1000;
export const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;

export function scheduleWindowError(startsAt: Date, durationMinutes: number, now: Date): 'TOO_SOON' | 'TOO_FAR' | 'DURATION' | null {
  const delta = startsAt.getTime() - now.getTime();
  if (delta < MIN_LEAD_MS) return 'TOO_SOON';
  if (delta > MAX_AHEAD_MS) return 'TOO_FAR';
  if (durationMinutes < 5 || durationMinutes > 120) return 'DURATION';
  return null;
}
