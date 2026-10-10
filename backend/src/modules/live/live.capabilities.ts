/**
 * Ce que le serveur sait faire pour le direct. L'application le lit avant de créer un direct,
 * pour dire clairement à l'hôte si la vidéo est disponible (au lieu d'un échec au démarrage).
 */
export type LiveCapabilities = { video: boolean };
export type LiveVideoConfig = { url?: string | null; apiKey?: string | null; apiSecret?: string | null };

/** La vidéo n'est disponible que si les trois identifiants LiveKit sont renseignés (vide ou blanc = absent). */
export function liveCapabilities(config: LiveVideoConfig): LiveCapabilities {
  return { video: !!(config.url?.trim() && config.apiKey?.trim() && config.apiSecret?.trim()) };
}
