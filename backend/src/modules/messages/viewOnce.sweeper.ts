import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { objectStorage } from '../../utils/objectStorage';

/**
 * Purge le FICHIER d'une photo, vidéo ou vocal à vue unique dès que TOUS ses destinataires l'ont ouvert, après un court délai technique
 * (VIEW_ONCE_PURGE_DELAY_SECONDS) qui laisse le temps de charger l'URL remise à l'ouverture. Aucune conservation après ouverture :
 * un message à vue unique ne peut pas être signalé, donc rien ne justifie de le garder. Le message reste dans la conversation (« ouvert »).
 * Une erreur de stockage laisse le fichier en place : nouvel essai au passage suivant.
 */
export async function purgeViewOnceMedia(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.VIEW_ONCE_PURGE_DELAY_SECONDS * 1000);
  const candidates = await prisma.message.findMany({
    where: { viewOnce: true, mediaKey: { not: null } },
    select: { id: true, mediaKey: true, viewOnceRecipients: { select: { openedAt: true } } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  let purged = 0;
  for (const c of candidates) {
    // Règle vérifiée ligne par ligne : une ligne jamais ouverte, ou ouverte après le délai, bloque la purge.
    const recipients = c.viewOnceRecipients;
    if (!c.mediaKey || recipients.length === 0 || recipients.some((r) => !r.openedAt || r.openedAt >= cutoff)) continue;
    try {
      await objectStorage.delete(c.mediaKey);
    } catch (error) {
      console.error(`[vue unique] purge du fichier impossible (message ${c.id}), nouvel essai au prochain passage`, error);
      continue;
    }
    await prisma.message.updateMany({ where: { id: c.id, mediaKey: c.mediaKey }, data: { mediaKey: null, mediaMime: null, mediaSize: null } });
    purged++;
  }
  return purged;
}

/** Lance la purge périodique (sans effet en test : les tests appellent `purgeViewOnceMedia` directement). */
export function startViewOnceSweeper(intervalMs = 60_000) {
  if (env.NODE_ENV === 'test') return null;
  const timer = setInterval(() => {
    purgeViewOnceMedia().catch((error) => console.error('[vue unique] passage de purge en échec', error));
  }, intervalMs);
  timer.unref();
  return timer;
}
