import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { notFound } from '../../utils/errors';

export async function loadMessageConversation(viewer: User, conversationId: string) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { members: { include: { user: true } } } });
  const me = conv?.members.find(m => m.userId === viewer.id);
  const other = conv?.members.find(m => m.userId !== viewer.id);
  if (!conv || !me) throw notFound('Conversation introuvable');
  if (!conv.isGroup && (!other || other.user.status !== 'ACTIVE')) throw notFound('Conversation introuvable');
  return { conv, me, other: other?.user ?? null };
}
