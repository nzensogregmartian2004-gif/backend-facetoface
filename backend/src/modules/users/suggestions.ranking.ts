/** Signaux de recommandation d'un créateur pour un spectateur (fonction pure, testée dans units.test.ts). */
export type SuggestionSignals = { followers: number; mutual: number; affinity: number };

/** Amis d'amis (plafonné à 5) > centres d'intérêt communs (plafonné à 4) > popularité (logarithmique, pour ne pas écraser les petits créateurs). */
export const suggestionScore = (s: SuggestionSignals) => 3 * Math.min(s.mutual, 5) + 1.5 * Math.min(s.affinity, 4) + Math.log1p(s.followers);

export type SuggestionReason = 'MUTUAL' | 'INTERESTS' | 'POPULAR';
export const suggestionReason = (s: SuggestionSignals): SuggestionReason => (s.mutual > 0 ? 'MUTUAL' : s.affinity > 0 ? 'INTERESTS' : 'POPULAR');

/** Tri décroissant par score, départage stable par identifiant. */
export function rankSuggestions<T extends { id: string }>(items: T[], score: (t: T) => number): T[] {
  return items.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s || (a.t.id < b.t.id ? -1 : 1)).map((x) => x.t);
}
