import { prisma } from '../../config/db';
import { blockedIdsFor } from '../content/access';
import { isUserOnline, publishRealtimeMany, setPresenceListener, setTypingHandler } from '../../realtime/realtime';

/** Délai avant « hors ligne » : une coupure réseau brève ne doit pas faire clignoter le statut. */
const OFFLINE_GRACE_MS = 5_000;
const pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();

/** Interlocuteurs d'une conversation privée : eux seuls reçoivent le statut en ligne (les groupes n'en ont pas). */
async function directPeers(userId: string): Promise<string[]> {
  const mine = await prisma.conversationMember.findMany({ where: { userId, conversation: { isGroup: false } }, select: { conversationId: true } });
  if (mine.length === 0) return [];
  const others = await prisma.conversationMember.findMany({ where: { conversationId: { in: mine.map((r) => r.conversationId) }, userId: { not: userId } }, select: { userId: true } });
  const blocked = await blockedIdsFor(userId);
  return [...new Set(others.map((o) => o.userId))].filter((id) => !blocked.includes(id));
}

async function announce(userId: string, online: boolean, lastSeenAt: Date | null) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { showOnlineStatus: true } });
  if (!user?.showOnlineStatus) return; // réglage désactivé : rien n'est annoncé
  const peers = await directPeers(userId);
  if (peers.length) publishRealtimeMany(peers, { type: 'PRESENCE', payload: { userId, online, lastSeenAt } });
}

/** Branche la présence et la saisie sur le temps réel. À appeler une fois au démarrage du serveur. */
export function initPresence() {
  setPresenceListener((userId, online) => {
    const pending = pendingOffline.get(userId);
    if (online) {
      if (pending) { clearTimeout(pending); pendingOffline.delete(userId); return; } // reconnexion rapide : personne n'a été prévenu du départ
      void announce(userId, true, null).catch(() => {});
      return;
    }
    const timer = setTimeout(async () => {
      pendingOffline.delete(userId);
      if (isUserOnline(userId)) return;
      const now = new Date();
      await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: now } }).catch(() => {});
      await announce(userId, false, now).catch(() => {});
    }, OFFLINE_GRACE_MS);
    timer.unref();
    pendingOffline.set(userId, timer);
  });

  setTypingHandler(async (userId, conversationId) => {
    const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { id: true } });
    if (!member) return;
    const [sender, others, blocked] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
      prisma.conversationMember.findMany({ where: { conversationId, userId: { not: userId } }, select: { userId: true } }),
      blockedIdsFor(userId),
    ]);
    const targets = others.map((o) => o.userId).filter((id) => !blocked.includes(id));
    if (targets.length) publishRealtimeMany(targets, { type: 'TYPING', payload: { conversationId, userId, displayName: sender?.displayName ?? '' } });
  });
}
