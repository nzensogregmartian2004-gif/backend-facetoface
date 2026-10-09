/**
 * Mode de lecture d'une vidéo. Fonction pure : aucune URL n'est produite ici, seulement la décision.
 * - Gratuit, public, avec CDN et playlist disponible : HLS public (adaptatif, URL CDN permanente, sans risque : rien à protéger).
 * - Payant, réservé aux abonnés, ou non public : fichier MP4 en URL SIGNÉE de courte durée, jamais l'URL publique du CDN.
 *   (Une playlist HLS signée ne signe pas les segments qu'elle référence : l'adaptatif est donc réservé au gratuit public.)
 */
export type PlaybackModeInput = { paid: boolean; subscriptionOnly: boolean; visibility: string; hasCdn: boolean; hasManifest: boolean };
export type PlaybackPlan = { mode: 'HLS_PUBLIC' | 'PROGRESSIVE_PRIVATE'; ttlSeconds: number };

export function playbackPlan(input: PlaybackModeInput, ttl: { standardTtl: number; paidTtl: number }): PlaybackPlan {
  if (input.paid) return { mode: 'PROGRESSIVE_PRIVATE', ttlSeconds: ttl.paidTtl };
  if (input.subscriptionOnly || input.visibility !== 'PUBLIC') return { mode: 'PROGRESSIVE_PRIVATE', ttlSeconds: ttl.standardTtl };
  if (input.hasCdn && input.hasManifest) return { mode: 'HLS_PUBLIC', ttlSeconds: ttl.standardTtl };
  return { mode: 'PROGRESSIVE_PRIVATE', ttlSeconds: ttl.standardTtl };
}
