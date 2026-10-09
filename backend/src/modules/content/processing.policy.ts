/**
 * Règles pures du traitement et de la sécurité des contenus (étape 10, lot 2). Aucune dépendance : testables sans base.
 */

/** Au-delà de ce délai, un traitement resté en PROCESSING est considéré comme bloqué (serveur redémarré en cours de transcodage). */
export const PROCESSING_STALE_MS = 15 * 60_000;

export type RestrictionInput = { paid: boolean; subscriptionOnly: boolean; visibility: string };

/**
 * Contenu réservé : payant, réservé aux abonnés, ou non public.
 * Un contenu réservé ne doit JAMAIS avoir de version HLS publique : le CDN public est permanent et partageable.
 */
export function isRestrictedContent(input: RestrictionInput): boolean {
  return input.paid || input.subscriptionOnly || input.visibility !== 'PUBLIC';
}

/**
 * Faut-il retirer les playlists HLS publiques d'un contenu qui devient réservé ?
 * Jamais si le « manifeste » est en réalité le fichier source (mode mémoire des tests), qui ne doit pas être supprimé.
 */
export function shouldPurgePublicHls(current: { manifestKey: string | null; videoKey: string | null }, restrictedAfter: boolean): boolean {
  return restrictedAfter && !!current.manifestKey && current.manifestKey !== current.videoKey;
}

/** Vrai si un traitement en PROCESSING n'a plus donné signe de vie depuis plus de PROCESSING_STALE_MS. */
export function isProcessingStale(updatedAt: Date, now: number = Date.now()): boolean {
  return now - updatedAt.getTime() > PROCESSING_STALE_MS;
}
