import { env } from '../../config/env';
import { getConfigValue } from '../config/config.service';
import { effectiveDownloadsEnabled } from './downloads.policy';

/**
 * Valeur administrateur de `DOWNLOADS.ENABLED`, gardée en mémoire pour que le sérialiseur (synchrone)
 * puisse indiquer aux applications si le téléchargement est offert. Le serveur relit la valeur à chaque
 * demande de téléchargement : la décision de protection ne dépend jamais de ce cache.
 */
let cached: unknown = undefined;

/** Relit le réglage en base. En cas d'erreur, la dernière valeur connue est conservée. */
export async function refreshDownloadsSetting(): Promise<boolean> {
  try { cached = await getConfigValue('DOWNLOADS.ENABLED'); } catch { /* garde la valeur précédente */ }
  return effectiveDownloadsEnabled(cached, env.DOWNLOADS_ENABLED);
}

/** Valeur effective pour l'affichage (synchrone). */
export function downloadsEnabledNow(): boolean {
  return effectiveDownloadsEnabled(cached, env.DOWNLOADS_ENABLED);
}

/** Relecture périodique, pour que l'affichage suive un changement de réglage sans redémarrer le serveur. */
export function startDownloadsSettingRefresh() {
  void refreshDownloadsSetting();
  const timer = setInterval(() => { void refreshDownloadsSetting(); }, 30_000);
  timer.unref();
}
