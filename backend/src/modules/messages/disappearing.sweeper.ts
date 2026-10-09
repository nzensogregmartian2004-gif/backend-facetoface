import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { objectStorage } from '../../utils/objectStorage';

/**
 * Supprime le CONTENU des messages éphémères arrivés à échéance : texte, média, épingle. La ligne reste (traçabilité des achats) mais n'est
 * plus jamais affichée. Un fichier partagé avec une copie transférée n'est supprimé que lorsqu'aucun autre message ne le référence.
 * Une erreur de stockage laisse le message à purger : nouvel essai au passage suivant.
 */
export async function purgeExpiredMessages(now: Date = new Date()): Promise<number> {
  const due = await prisma.message.findMany({
    where: { expiresAt: { lte: now }, deletedAt: null },
    select: { id: true, conversationId: true, createdAt: true, mediaKey: true },
    orderBy: { expiresAt: 'asc' },
    take: 200,
  });

  let purged = 0;
  for (const m of due) {
    if (m.mediaKey) {
      const shared = await prisma.message.count({ where: { mediaKey: m.mediaKey, id: { not: m.id }, deletedAt: null } });
      if (shared === 0) {
        try {
          await objectStorage.delete(m.mediaKey);
        } catch (error) {
          console.error(`[éphémères] suppression du fichier impossible (message ${m.id}), nouvel essai au prochain passage`, error);
          continue;
        }
      }
    }
    await prisma.$transaction(async (tx) => {
      const current = await tx.message.updateMany({
        where: { id: m.id, deletedAt: null },
        data: { deletedAt: now, text: null, mediaKey: null, mediaMime: null, mediaSize: null, mediaDurationMs: null, pinnedAt: null },
      });
      if (current.count !== 1) return;

      // Un message expiré ne compte plus comme non lu.
      const members = await tx.conversationMember.findMany({ where: { conversationId: m.conversationId, unreadCount: { gt: 0 } } });
      for (const rec of members) {
        if (!rec.lastReadAt || m.createdAt > rec.lastReadAt) {
          await tx.conversationMember.update({ where: { id: rec.id }, data: { unreadCount: { decrement: 1 } } });
        }
      }

      // Si c'était le dernier message, la boîte affiche le plus récent encore valable.
      const conv = await tx.conversation.findUnique({ where: { id: m.conversationId }, select: { lastMessageId: true } });
      if (conv?.lastMessageId === m.id) {
        const prev = await tx.message.findFirst({
          where: { conversationId: m.conversationId, deletedAt: null, id: { not: m.id }, moderationStatus: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, createdAt: true },
        });
        await tx.conversation.update({
          where: { id: m.conversationId },
          data: { lastMessageId: prev?.id ?? null, ...(prev ? { lastMessageAt: prev.createdAt } : {}) },
        });
      }
    });
    purged++;
  }
  return purged;
}

/** Lance la purge périodique (sans effet en test : les tests appellent `purgeExpiredMessages` directement). */
export function startDisappearingSweeper(intervalMs = 60_000) {
  if (env.NODE_ENV === 'test') return null;
  const timer = setInterval(() => {
    purgeExpiredMessages().catch((error) => console.error('[éphémères] passage de purge en échec', error));
  }, intervalMs);
  timer.unref();
  return timer;
}
