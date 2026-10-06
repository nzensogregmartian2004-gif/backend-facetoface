import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { conflict, forbidden, notFound } from '../../utils/errors';
import { hasActiveSubscription } from '../subscriptions/subscriptions.service';

const MAX_TITLE = 120;

function ensureCreator(user: User) {
  if (!user.isCreator) throw new Error('CREATOR_REQUIRED');
}

async function assertAccess(user: User, live: any) {
  if (live.access === 'SUBSCRIBERS' && live.hostId !== user.id && !(await hasActiveSubscription(user.id, live.hostId))) throw forbidden('SUBSCRIPTION_REQUIRED', 'Abonnez-vous à ce créateur pour accéder à ce Live');
}

async function getOwnedLive(userId: string, liveId: string) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live) throw new Error('LIVE_NOT_FOUND');
  if (live.hostId !== userId) throw new Error('LIVE_FORBIDDEN');
  return live;
}

function serialize(live: any) {
  return {
    id: live.id,
    title: live.title,
    description: live.description,
    thumbnailKey: live.thumbnailKey,
    visibility: live.visibility,
    access: live.access,
    status: live.status,
    scheduledAt: live.scheduledAt,
    startedAt: live.startedAt,
    endedAt: live.endedAt,
    currentViewers: live.currentViewers,
    peakViewers: live.peakViewers,
    uniqueViewers: live.uniqueViewers,
    totalWatchSeconds: live.totalWatchSeconds?.toString?.() ?? String(live.totalWatchSeconds ?? 0),
    totalMessages: live.totalMessages,
    totalReactions: live.totalReactions,
    host: live.host ? { id: live.host.id, username: live.host.username, displayName: live.host.displayName, avatarUrl: live.host.avatarUrl } : undefined,
  };
}

export async function createLive(user: User, input: {
  title: string; description?: string; thumbnailKey?: string; visibility: 'PUBLIC'|'UNLISTED'; access: 'EVERYONE'|'SUBSCRIBERS'; scheduledAt?: Date;
}) {
  ensureCreator(user);
  if (input.scheduledAt && input.scheduledAt <= new Date()) throw new Error('SCHEDULED_AT_MUST_BE_FUTURE');
  const live = await prisma.live.create({
    data: {
      hostId: user.id,
      title: input.title.slice(0, MAX_TITLE),
      description: input.description,
      thumbnailKey: input.thumbnailKey,
      visibility: input.visibility,
      access: input.access,
      status: input.scheduledAt ? 'SCHEDULED' : 'LIVE',
      scheduledAt: input.scheduledAt,
      startedAt: input.scheduledAt ? null : new Date(),
      streamKey: randomBytes(24).toString('hex'),
    },
    include: { host: true },
  });
  return { live: serialize(live), streamKey: live.streamKey };
}

export async function updateLive(user: User, liveId: string, input: {
  title?: string; description?: string; thumbnailKey?: string; visibility?: 'PUBLIC'|'UNLISTED'; access?: 'EVERYONE'|'SUBSCRIBERS'; scheduledAt?: Date;
}) {
  const live = await getOwnedLive(user.id, liveId);
  if (live.status !== 'SCHEDULED') throw new Error('LIVE_NOT_SCHEDULED');
  if (input.scheduledAt && input.scheduledAt <= new Date()) throw new Error('SCHEDULED_AT_MUST_BE_FUTURE');
  const updated = await prisma.live.update({ where: { id: liveId }, data: input });
  return serialize(updated);
}

export async function startLive(user: User, liveId: string) {
  const live = await getOwnedLive(user.id, liveId);
  if (!['SCHEDULED', 'LIVE'].includes(live.status)) throw new Error('LIVE_CANNOT_START');
  const updated = await prisma.live.update({
    where: { id: liveId },
    data: { status: 'LIVE', startedAt: live.startedAt ?? new Date(), endedAt: null },
    include: { host: true },
  });
  return { live: serialize(updated), streamKey: updated.streamKey };
}

export async function endLive(user: User, liveId: string) {
  const live = await getOwnedLive(user.id, liveId);
  if (live.status !== 'LIVE') throw new Error('LIVE_NOT_ACTIVE');
  const now = new Date();
  const active = await prisma.liveViewer.findMany({ where: { liveId, isActive: true } });
  const extraWatch = active.reduce((n, v) => n + Math.max(0, Math.floor((now.getTime() - v.joinedAt.getTime()) / 1000)), 0);
  const updated = await prisma.$transaction(async tx => {
    for (const viewer of active) {
      await tx.liveViewer.update({
        where: { id: viewer.id },
        data: { isActive: false, leftAt: now, watchSeconds: { increment: Math.max(0, Math.floor((now.getTime() - viewer.joinedAt.getTime()) / 1000)) } },
      });
    }
    return tx.live.update({
      where: { id: liveId },
      data: { status: 'ENDED', endedAt: now, currentViewers: 0, totalWatchSeconds: { increment: BigInt(extraWatch) } },
      include: { host: true },
    });
  });
  return serialize(updated);
}

export async function cancelLive(user: User, liveId: string) {
  const live = await getOwnedLive(user.id, liveId);
  if (live.status !== 'SCHEDULED') throw new Error('LIVE_NOT_SCHEDULED');
  return serialize(await prisma.live.update({ where: { id: liveId }, data: { status: 'CANCELLED' } }));
}

export async function listLives(status?: 'SCHEDULED'|'LIVE'|'ENDED', limit = 20) {
  const rows = await prisma.live.findMany({
    where: { ...(status ? { status } : { status: { in: ['SCHEDULED', 'LIVE'] } }), moderationStatus: 'ACTIVE', visibility: 'PUBLIC', access: 'EVERYONE' },
    orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }, { startedAt: 'desc' }],
    take: limit,
    include: { host: true },
  });
  return rows.map(serialize);
}

export async function getLive(liveId: string, viewer?: User) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' }, include: { host: true } });
  if (!live || live.visibility === 'UNLISTED') throw notFound('Live introuvable');
  if (live.access === 'SUBSCRIBERS' && (!viewer || !(await hasActiveSubscription(viewer.id, live.hostId)))) throw notFound('Live introuvable');
  return serialize(live);
}

export async function joinLive(user: User, liveId: string) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live) throw notFound('Live introuvable');
  await assertAccess(user, live);
  if (live.status !== 'LIVE') throw new Error('LIVE_NOT_ACTIVE');
  if (live.hostId === user.id) return { live: serialize(live), joined: false };

  const now = new Date();
  const result = await prisma.$transaction(async tx => {
    const existing = await tx.liveViewer.findUnique({ where: { liveId_userId: { liveId, userId: user.id } } });
    if (existing?.isActive) return { live, joined: false };
    await tx.liveViewer.upsert({
      where: { liveId_userId: { liveId, userId: user.id } },
      create: { liveId, userId: user.id, joinedAt: now, isActive: true, leftAt: null },
      update: { joinedAt: now, leftAt: null, isActive: true },
    });
    return tx.live.update({
      where: { id: liveId },
      data: {
        currentViewers: { increment: 1 },
        uniqueViewers: existing ? undefined : { increment: 1 },
      },
    });
  });
  const current = typeof result === 'object' && 'live' in result ? result.live : result;
  const updated = await prisma.live.update({
    where: { id: liveId },
    data: { peakViewers: Math.max(current.peakViewers, current.currentViewers) },
    include: { host: true },
  });
  return { live: serialize(updated), joined: true };
}

export async function leaveLive(user: User, liveId: string) {
  const viewer = await prisma.liveViewer.findUnique({ where: { liveId_userId: { liveId, userId: user.id } } });
  if (!viewer || !viewer.isActive) return { left: false };
  const now = new Date();
  const seconds = Math.max(0, Math.floor((now.getTime() - viewer.joinedAt.getTime()) / 1000));
  await prisma.$transaction([
    prisma.liveViewer.update({ where: { id: viewer.id }, data: { isActive: false, leftAt: now, watchSeconds: { increment: seconds } } }),
    prisma.live.update({ where: { id: liveId }, data: { currentViewers: { decrement: 1 }, totalWatchSeconds: { increment: BigInt(seconds) } } }),
  ]);
  return { left: true, watchSeconds: seconds };
}

export async function chat(user: User, liveId: string, text: string) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live || live.status !== 'LIVE') throw new Error('LIVE_NOT_ACTIVE');
  await assertAccess(user, live);
  const message = await prisma.liveChatMessage.create({ data: { liveId, authorId: user.id, text }, include: { author: true } });
  await prisma.live.update({ where: { id: liveId }, data: { totalMessages: { increment: 1 } } });
  return { id: message.id, liveId, text: message.text, createdAt: message.createdAt, author: { id: message.author.id, username: message.author.username, displayName: message.author.displayName, avatarUrl: message.author.avatarUrl } };
}

export async function listChat(user: User, liveId: string, limit = 50) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live) throw notFound('Live introuvable');
  await assertAccess(user, live);
  const messages = await prisma.liveChatMessage.findMany({ where: { liveId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: limit, include: { author: true } });
  return messages.reverse().map(m => ({ id: m.id, liveId, text: m.text, createdAt: m.createdAt, author: { id: m.author.id, username: m.author.username, displayName: m.author.displayName, avatarUrl: m.author.avatarUrl } }));
}

export async function react(user: User, liveId: string, type: 'LIKE'|'LOVE'|'FIRE'|'WOW') {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live || live.status !== 'LIVE') throw new Error('LIVE_NOT_ACTIVE');
  await assertAccess(user, live);
  const reaction = await prisma.liveReaction.upsert({
    where: { liveId_userId_type: { liveId, userId: user.id, type } },
    create: { liveId, userId: user.id, type, count: 1 },
    update: { count: { increment: 1 } },
  });
  await prisma.live.update({ where: { id: liveId }, data: { totalReactions: { increment: 1 } } });
  return { type, count: reaction.count };
}

export async function stats(user: User, liveId: string) {
  const live = await getOwnedLive(user.id, liveId);
  const [reactions, chatMessages] = await Promise.all([
    prisma.liveReaction.groupBy({ by: ['type'], where: { liveId }, _sum: { count: true } }),
    prisma.liveChatMessage.count({ where: { liveId, deletedAt: null } }),
  ]);
  return {
    live: serialize(live),
    reactions: reactions.map(r => ({ type: r.type, count: r._sum.count ?? 0 })),
    chatMessages,
  };
}
