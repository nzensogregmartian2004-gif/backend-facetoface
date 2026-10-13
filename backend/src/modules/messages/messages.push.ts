import { prisma } from '../../config/db';
import { sendPush } from '../notifications/push.service';

const PUSH_CHUNK = 25;

/**
 * Push « nouveau message », envoyée APRÈS l'enregistrement du message (jamais dans la transaction).
 * Les membres dont la conversation est en sourdine (mutedUntil dans le futur) n'en reçoivent pas.
 * La notification dans l'application reste créée comme avant : seule la push est coupée.
 */
export async function pushNewMessage(conversationId: string, senderId: string) {
  const members = await prisma.conversationMember.findMany({
    where: {
      conversationId,
      userId: { not: senderId },
      OR: [{ mutedUntil: null }, { mutedUntil: { lte: new Date() } }],
    },
    select: { userId: true },
  });
  for (let i = 0; i < members.length; i += PUSH_CHUNK) {
    await Promise.all(members.slice(i, i + PUSH_CHUNK).map((m) =>
      sendPush(m.userId, { type: 'NEW_MESSAGE', payload: { type: 'NEW_MESSAGE', conversationId }, actorId: senderId }).catch(() => {}),
    ));
  }
}
