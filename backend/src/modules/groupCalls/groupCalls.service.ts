import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { callProvider } from '../../utils/callProvider';

const MAX = 4;
const participant = (r: any) => ({ id: r.user.id, username: r.user.username, displayName: r.user.displayName, avatarUrl: r.user.avatarUrl });

async function member(userId: string, conversationId: string) {
  const m = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } }, include: { user: true } });
  if (!m) throw forbidden('GROUP_MEMBER_REQUIRED', 'Vous devez être membre du groupe');
  return m;
}

export async function create(user: User, input: { conversationId: string; type: 'AUDIO'|'VIDEO' }) {
  const m = await member(user.id, input.conversationId);
  const conversation = await prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { id: true, isGroup: true } });
  if (!conversation?.isGroup) throw badRequest('GROUP_REQUIRED', 'Un appel de groupe nécessite une conversation de groupe');
  const active = await prisma.groupCall.findFirst({ where: { conversationId: conversation.id, status: 'ACTIVE' } });
  if (active) throw conflict('GROUP_CALL_ACTIVE', 'Un appel de groupe est déjà en cours', { callId: active.id });
  const call = await prisma.groupCall.create({ data: { conversationId: conversation.id, hostId: user.id, type: input.type, room: `g-${conversation.id}-${Date.now().toString(36)}` } });
  await prisma.groupCallParticipant.create({ data: { callId: call.id, userId: user.id } });
  return join(user, call.id);
}

export async function join(user: User, id: string) {
  const call = await prisma.groupCall.findUnique({ where: { id }, include: { conversation: true, participants: { include: { user: true }, orderBy: { joinedAt: 'asc' } } } });
  if (!call || call.status !== 'ACTIVE') throw notFound('Appel de groupe introuvable');
  await member(user.id, call.conversationId);
  const exists = call.participants.some(p => p.userId === user.id);
  if (!exists && call.participants.length >= MAX) throw conflict('GROUP_CALL_FULL', `Un appel de groupe est limité à ${MAX} participants`);
  if (!exists) await prisma.groupCallParticipant.create({ data: { callId: id, userId: user.id } });
  const identity = `group:${call.id}:${user.id}`;
  const grant = callProvider.grant({ room: call.room, identity, displayName: user.displayName, video: call.type === 'VIDEO', ttlSeconds: 60 * 60 });
  const current = await prisma.groupCall.findUniqueOrThrow({ where: { id }, include: { participants: { include: { user: true }, orderBy: { joinedAt: 'asc' } } } });
  return { call: { id: current.id, conversationId: current.conversationId, type: current.type, status: current.status, room: current.room, hostId: current.hostId, participants: current.participants.map(participant) }, grant };
}

export async function leave(user: User, id: string) {
  const call = await prisma.groupCall.findUnique({ where: { id } });
  if (!call) throw notFound('Appel de groupe introuvable');
  await member(user.id, call.conversationId);
  await prisma.groupCallParticipant.updateMany({ where: { callId: id, userId: user.id, leftAt: null }, data: { leftAt: new Date() } });
  return { ok: true };
}

export async function end(user: User, id: string) {
  const call = await prisma.groupCall.findUnique({ where: { id } });
  if (!call) throw notFound('Appel de groupe introuvable');
  if (call.hostId !== user.id) throw forbidden('GROUP_CALL_HOST_REQUIRED', 'Seul l’organisateur peut terminer l’appel');
  await prisma.groupCall.update({ where: { id }, data: { status: 'ENDED', endedAt: new Date() } });
  await callProvider.closeRoom(call.room);
  return { ok: true };
}

export async function get(user: User, id: string) {
  const call = await prisma.groupCall.findUnique({ where: { id }, include: { participants: { include: { user: true }, orderBy: { joinedAt: 'asc' } } } });
  if (!call) throw notFound('Appel de groupe introuvable');
  await member(user.id, call.conversationId);
  return { call: { id: call.id, conversationId: call.conversationId, type: call.type, status: call.status, room: call.room, hostId: call.hostId, participants: call.participants.map(participant) } };
}
