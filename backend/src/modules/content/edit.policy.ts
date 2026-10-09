/**
 * Découpage et couverture d'une vidéo (étape 13, lot 1) : règles pures, sans base, testables seules.
 * Le serveur n'accepte jamais un découpage hors des bornes de la vidéo envoyée ; il recalcule la durée réelle.
 */
export const MIN_EDIT_MS = 1000;
/** Marge tolérée sur les bornes : le mobile arrondit la durée à la seconde. */
export const EDIT_TOLERANCE_MS = 1000;
/** En dessous de cet écart avec la fin de la source, la fin n'est pas considérée comme découpée. */
const END_TRIM_THRESHOLD_MS = 500;

export type VideoEditInput = { startMs?: number; endMs?: number; coverMs?: number };
export type EditResult =
  | { ok: true; effectiveSeconds: number; trimStartMs: number | null; trimEndMs: number | null; coverMs: number | null }
  | { ok: false; code: string; message: string };

const fail = (code: string, message: string): EditResult => ({ ok: false, code, message });

export function normalizeEdit(input: VideoEditInput | undefined, sourceSeconds: number, kind: 'VIDEO' | 'SHORT', shortMaxSeconds: number): EditResult {
  const sourceMs = sourceSeconds * 1000;
  if (!input || (input.startMs === undefined && input.endMs === undefined && input.coverMs === undefined)) {
    if (kind === 'SHORT' && sourceMs > shortMaxSeconds * 1000) return fail('SHORT_TOO_LONG', `Un Short dure ${shortMaxSeconds} secondes maximum`);
    return { ok: true, effectiveSeconds: sourceSeconds, trimStartMs: null, trimEndMs: null, coverMs: null };
  }
  const start = input.startMs ?? 0;
  const end = input.endMs ?? sourceMs;
  if (end > sourceMs + EDIT_TOLERANCE_MS) return fail('EDIT_OUT_OF_RANGE', 'La fin du découpage dépasse la durée de la vidéo');
  if (start < 0 || start >= end) return fail('EDIT_INVALID_RANGE', 'Le début du découpage doit être avant sa fin');
  const cappedEnd = Math.min(end, sourceMs);
  const trimmed = start > 0 || cappedEnd < sourceMs - END_TRIM_THRESHOLD_MS;
  const effectiveMs = trimmed ? cappedEnd - start : sourceMs;
  if (effectiveMs < MIN_EDIT_MS) return fail('EDIT_TOO_SHORT', 'Le découpage doit durer au moins 1 seconde');
  if (kind === 'SHORT' && effectiveMs > shortMaxSeconds * 1000) return fail('SHORT_TOO_LONG', `Un Short dure ${shortMaxSeconds} secondes maximum`);
  if (input.coverMs !== undefined && (input.coverMs < 0 || input.coverMs >= effectiveMs)) return fail('COVER_OUT_OF_RANGE', 'La couverture doit être dans la vidéo découpée');
  return {
    ok: true,
    effectiveSeconds: trimmed ? Math.max(1, Math.round(effectiveMs / 1000)) : sourceSeconds,
    trimStartMs: trimmed ? start : null,
    trimEndMs: trimmed ? cappedEnd : null,
    coverMs: input.coverMs ?? null,
  };
}
