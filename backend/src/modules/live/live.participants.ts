import { prisma } from '../../config/db';
import { forbidden } from '../../utils/errors';

export function findParticipant(liveId: string, userId: string) {
  return prisma.liveParticipant.findUnique({ where: { liveId_userId: { liveId, userId } } });
}

/** Places de co-host occupées : invitations en attente et co-hosts actifs. Un retrait libère sa place. */
export function countCoHostSlots(liveId: string): Promise<number> {
  return prisma.liveParticipant.count({
    where: { liveId, removedAt: null, OR: [{ invitedAt: { not: null } }, { acceptedAt: { not: null } }] },
  });
}

/** Un utilisateur bloqué sur un Live ne peut plus le rejoindre, le suivre en chat ni réagir. */
export async function assertNotBlocked(liveId: string, userId: string): Promise<void> {
  const p = await prisma.liveParticipant.findUnique({ where: { liveId_userId: { liveId, userId } }, select: { blockedAt: true } });
  if (p?.blockedAt) throw forbidden('LIVE_BLOCKED', 'Vous ne pouvez plus participer à ce Live');
}
