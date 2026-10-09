import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { assertPriceInRange, DEFAULT_CURRENCY } from '../../utils/currency';
import { randomToken } from '../../utils/crypto';
import { objectStorage } from '../../utils/objectStorage';
import { env } from '../../config/env';
import { toUserCards } from '../users/profile.service';
import { notify } from '../notifications/notifications.service';

export const MAX_MEMBERS = 100;

async function member(viewer: User, conversationId: string) {
  const row = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: viewer.id } }, include: { conversation: true } });
  if (!row || !row.conversation.isGroup) throw notFound('Groupe introuvable');
  return row;
}

async function admin(viewer: User, conversationId: string) {
  const row = await member(viewer, conversationId);
  if (row.role !== 'ADMIN') throw forbidden('GROUP_ADMIN_REQUIRED', 'Droits administrateur requis');
  return row;
}

export async function createGroup(viewer: User, input: { name: string; description?: string; allowPaidContent?: boolean; memberIds?: string[] }) {
  const name = input.name.trim();
  if (!name) throw badRequest('GROUP_NAME_REQUIRED', 'Nom du groupe requis');
  const ids = [...new Set((input.memberIds ?? []).filter((id) => id && id !== viewer.id))];
  if (ids.length + 1 > MAX_MEMBERS) throw badRequest('GROUP_TOO_LARGE', `Maximum ${MAX_MEMBERS} membres`);
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } }) : [];
  if (users.length !== ids.length) throw badRequest('INVALID_MEMBERS', 'Un ou plusieurs membres sont invalides');
  const conv = await prisma.conversation.create({
    data: {
      isGroup: true, name, description: input.description?.trim() || null, allowPaidContent: input.allowPaidContent ?? true, ownerId: viewer.id,
      lastMessageAt: new Date(), // le groupe apparaît dans la boîte de réception dès sa création (même sans message)
      members: { create: [{ userId: viewer.id, role: 'ADMIN' }, ...ids.map((userId) => ({ userId, role: 'MEMBER' as const }))] },
    },
    include: { members: { include: { user: true } } },
  });
  await prisma.$transaction(async (tx) => {
    for (const id of ids) await notify(tx, { userId: id, type: 'NEW_MESSAGE', actorId: viewer.id, targetType: 'CONVERSATION', targetId: conv.id });
  });
  return groupDto(viewer, conv);
}

export async function groupDto(viewer: User, conv: any) {
  const me = conv.members.find((m: any) => m.userId === viewer.id);
  if (!me || !conv.isGroup) throw notFound('Groupe introuvable');
  const cards = await toUserCards(viewer, conv.members.map((m: any) => m.user));
  const cardById = new Map(cards.map((c: any) => [c.id, c]));
  return {
    id: conv.id, isGroup: true, name: conv.name, photoKey: conv.photoKey, description: conv.description,
    allowPaidContent: conv.allowPaidContent, unreadCount: me.unreadCount, lastMessageAt: conv.lastMessageAt,
    entry: conv.entryPrice != null ? { price: conv.entryPrice, currency: conv.entryCurrency ?? DEFAULT_CURRENCY } : null, isOwner: conv.ownerId === viewer.id,
    members: conv.members.map((m: any) => ({ id: m.userId, role: m.role, user: cardById.get(m.userId) ?? null })),
    memberCount: conv.members.length, myRole: me.role,
  };
}

export async function getGroup(viewer: User, conversationId: string) {
  const row = await member(viewer, conversationId);
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { members: { include: { user: true } } } });
  return { group: await groupDto(viewer, conv) };
}

export async function updateGroup(viewer: User, conversationId: string, input: { name?: string; description?: string | null; allowPaidContent?: boolean; photoKey?: string | null; entryPrice?: number | null }) {
  await admin(viewer, conversationId);
  const data: Prisma.ConversationUpdateInput = {};
  if (input.name !== undefined) { const name = input.name.trim(); if (!name) throw badRequest('GROUP_NAME_REQUIRED', 'Nom du groupe requis'); data.name = name; }
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.allowPaidContent !== undefined) data.allowPaidContent = input.allowPaidContent;
  if (input.entryPrice !== undefined) { // accès payant : seuls les nouveaux membres paient ; les membres présents restent admis
    if (input.entryPrice === null) { data.entryPrice = null; data.entryCurrency = null; }
    else { assertPriceInRange(input.entryPrice, DEFAULT_CURRENCY, env.PAID_MESSAGE_MIN_FCFA, env.PAID_MESSAGE_MAX_FCFA, 'GROUP_PRICE_INVALID', 'entryPrice'); data.entryPrice = input.entryPrice; data.entryCurrency = DEFAULT_CURRENCY; }
  }
  if (input.photoKey !== undefined) {
    if (input.photoKey !== null && !input.photoKey.startsWith(`groups/${conversationId}/`)) throw badRequest('INVALID_GROUP_PHOTO', 'Photo de groupe invalide');
    if (input.photoKey) { const info = await objectStorage.head(input.photoKey); if (!info || !(info.contentType ?? '').toLowerCase().startsWith('image/')) throw badRequest('INVALID_GROUP_PHOTO', 'Photo de groupe invalide'); if (info.size > 8 * 1024 * 1024) throw badRequest('GROUP_PHOTO_TOO_LARGE', 'Photo trop volumineuse'); }
    data.photoKey = input.photoKey;
  }
  const conv = await prisma.conversation.update({ where: { id: conversationId }, data, include: { members: { include: { user: true } } } });
  return { group: await groupDto(viewer, conv) };
}

export async function addMembers(viewer: User, conversationId: string, userIds: string[]) {
  await admin(viewer, conversationId);
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { members: true } });
  if (conv.entryPrice != null) throw forbidden('GROUP_PAYMENT_REQUIRED', "Ce groupe est payant : les nouveaux membres rejoignent avec l'invitation et règlent l'accès");
  const ids = [...new Set(userIds.filter((id) => id !== viewer.id))];
  if (conv.members.length + ids.filter((id) => !conv.members.some((m) => m.userId === id)).length > MAX_MEMBERS) throw badRequest('GROUP_TOO_LARGE', `Maximum ${MAX_MEMBERS} membres`);
  const users = await prisma.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } });
  if (users.length !== ids.length) throw badRequest('INVALID_MEMBERS', 'Un ou plusieurs membres sont invalides');
  await prisma.conversationMember.createMany({ data: ids.filter((id) => !conv.members.some((m) => m.userId === id)).map((userId) => ({ conversationId, userId, role: 'MEMBER' })) , skipDuplicates: true });
  return getGroup(viewer, conversationId);
}

export async function removeMember(viewer: User, conversationId: string, userId: string) {
  await admin(viewer, conversationId);
  if (userId === viewer.id) throw badRequest('USE_LEAVE', 'Utilisez quitter pour vous-même');
  const target = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!target) throw notFound('Membre introuvable');
  const owner = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { ownerId: true } });
  if (owner?.ownerId === userId) throw forbidden('OWNER_PROTECTED', 'Le propriétaire du groupe ne peut pas être retiré');
  await prisma.viewOnceRecipient.deleteMany({ where: { userId, openedAt: null, message: { conversationId } } });
  await prisma.conversationMember.delete({ where: { id: target.id } });
}

export async function setRole(viewer: User, conversationId: string, userId: string, role: 'ADMIN'|'MEMBER') {
  await admin(viewer, conversationId);
  const target = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!target) throw notFound('Membre introuvable');
  if (role === 'MEMBER' && target.role === 'ADMIN') {
    const admins = await prisma.conversationMember.count({ where: { conversationId, role: 'ADMIN' } });
    if (admins <= 1) throw badRequest('LAST_ADMIN', 'Le groupe doit conserver un administrateur');
  }
  await prisma.conversationMember.update({ where: { id: target.id }, data: { role } });
}

export async function leaveGroup(viewer: User, conversationId: string) {
  const row = await member(viewer, conversationId);
  if (row.role === 'ADMIN') {
    const next = await prisma.conversationMember.findFirst({ where: { conversationId, userId: { not: viewer.id } }, orderBy: { role: 'asc' } });
    if (next) await prisma.conversationMember.update({ where: { id: next.id }, data: { role: 'ADMIN' } });
  }
  if (row.conversation.ownerId === viewer.id) { // le propriétaire qui part transmet la propriété à un autre membre (admin d'abord)
    const heir = await prisma.conversationMember.findFirst({ where: { conversationId, userId: { not: viewer.id } }, orderBy: [{ role: 'asc' }, { id: 'asc' }] });
    await prisma.conversation.update({ where: { id: conversationId }, data: { ownerId: heir?.userId ?? null } });
  }
  await prisma.viewOnceRecipient.deleteMany({ where: { userId: viewer.id, openedAt: null, message: { conversationId } } });
  await prisma.conversationMember.delete({ where: { id: row.id } });
}

export async function createInvite(viewer: User, conversationId: string) {
  await admin(viewer, conversationId);
  const token = randomToken(32);
  const invite = await prisma.conversationInvite.create({ data: { conversationId, createdById: viewer.id, token } });
  return { invite: { token: invite.token, expiresAt: invite.expiresAt, uses: invite.uses, maxUses: invite.maxUses } };
}

export async function joinByInvite(viewer: User, token: string) {
  const invite = await prisma.conversationInvite.findUnique({ where: { token }, include: { conversation: true } });
  if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()) || (invite.maxUses != null && invite.uses >= invite.maxUses) || !invite.conversation.isGroup) throw notFound('Invitation invalide ou expirée');
  const existing = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: invite.conversationId, userId: viewer.id } } });
  if (!existing && invite.conversation.entryPrice != null) throw new AppError(402, 'GROUP_PAYMENT_REQUIRED', "Ce groupe est payant : réglez l'accès pour le rejoindre", { groupId: invite.conversationId });
  if (!existing) {
    const count = await prisma.conversationMember.count({ where: { conversationId: invite.conversationId } });
    if (count >= MAX_MEMBERS) throw conflict('GROUP_FULL', 'Le groupe est complet');
    await prisma.$transaction(async (tx) => {
      await tx.conversationMember.create({ data: { conversationId: invite.conversationId, userId: viewer.id, role: 'MEMBER' } });
      await tx.conversationInvite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
    });
  }
  return getGroup(viewer, invite.conversationId);
}

export async function revokeInvite(viewer: User, conversationId: string, token: string) {
  await admin(viewer, conversationId);
  await prisma.conversationInvite.updateMany({ where: { conversationId, token, revokedAt: null }, data: { revokedAt: new Date() } });
}


export async function photoUploadUrl(viewer: User, conversationId: string, contentType: string) {
  await admin(viewer, conversationId);
  if (!['image/jpeg','image/png','image/webp'].includes(contentType.toLowerCase())) throw badRequest('UNSUPPORTED_GROUP_PHOTO', 'Format image non pris en charge');
  const key = `groups/${conversationId}/${viewer.id}/${randomToken(10)}.${contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'}`;
  return { upload: { ...objectStorage.presignUpload(key, contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

/** Aperçu d'une invitation (nom, membres, prix) sans rien engager. 404 si l'invitation n'est plus valable. */
export async function previewInvite(token: string) {
  const invite = await prisma.conversationInvite.findUnique({ where: { token }, include: { conversation: true } });
  if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()) || (invite.maxUses != null && invite.uses >= invite.maxUses) || !invite.conversation.isGroup) throw notFound('Invitation invalide ou expirée');
  const memberCount = await prisma.conversationMember.count({ where: { conversationId: invite.conversationId } });
  return { group: { id: invite.conversationId, name: invite.conversation.name, description: invite.conversation.description, memberCount, entry: invite.conversation.entryPrice != null ? { price: invite.conversation.entryPrice, currency: invite.conversation.entryCurrency ?? DEFAULT_CURRENCY } : null } };
}
