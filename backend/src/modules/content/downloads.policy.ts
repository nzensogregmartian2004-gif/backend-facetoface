/**
 * Réglage global des téléchargements (lot 1).
 * La valeur administrateur (`DOWNLOADS.ENABLED`) prime ; à défaut, la variable d'environnement sert de repli.
 * Une valeur administrateur qui n'est pas un booléen est ignorée, pour ne jamais ouvrir un téléchargement par erreur.
 */
export function effectiveDownloadsEnabled(configValue: unknown, envFallback: boolean): boolean {
  return typeof configValue === 'boolean' ? configValue : envFallback;
}
