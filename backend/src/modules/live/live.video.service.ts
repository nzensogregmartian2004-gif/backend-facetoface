import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { notify } from '../notifications/notifications.service';
import { publishToRoom } from '../../realtime/realtime';
import { signLivekitToken } from '../../utils/callProvider';
import { AppError, conflict, forbidden, notFound } from '../../utils/errors';
import { canJoinLiveRoom } from './live.service';
import { countCoHostSlots, findParticipant } from './live.participants';
import { LIVE_COHOST_LIMIT, liveRoomName, participantState, resolveVideoRole, videoGrantFor } from './live.video.grants';
import { liveVideoConfigured, removeFromRoom, setPublishPermission } from './live.livekit';

const TOKEN_TTL_SECONDS = 600;

async function liveFor(liveId: string) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live) throw notFound('Live introuvable');
  return live;
}
const requireHost = (user: User, live: { hostId: string }) => { if (live.hostId !== user.id) throw forbidden('LIVE_FORBIDDEN', 'Réservé à l’hôte du Live'); };
const requireLive = (live: { status: string }) => { if (live.status !== 'LIVE') throw conflict('LIVE_NOT_ACTIVE', 'Ce Live n’est pas en cours'); };

/** Applique une décision sur les droits de publication AVANT de l'enregistrer : une sanction non appliquée n'est jamais annoncée. */
async function enforcePublish(liveId: string, userId: string, canPublish: boolean) {
  if (!liveVideoConfigured()) return;
  try { await setPublishPermission(liveId, userId, canPublish); }
  catch { throw new AppError(502, 'VIDEO_PROVIDER_ERROR', 'Le serveur vidéo n’a pas pu appliquer la décision. Réessayez.'); }
}

const dto = (userId: string, p: Parameters<typeof participantState>[0]) => ({
  userId, state: participantState(p), muted: !!p?.mutedAt, invitedAt: p?.invitedAt ?? null, acceptedAt: p?.acceptedAt ?? null, removedAt: p?.removedAt ?? null, blockedAt: p?.blockedAt ?? null,
});

/** Jeton vidéo du Live : mêmes règles d'accès que la lecture ; le rôle et le droit de publier viennent du serveur. */
export async function issueLiveToken(user: User, liveId: string) {
  if (!liveVideoConfigured()) throw new AppError(503, 'VIDEO_UNAVAILABLE', 'La vidéo en direct n’est pas configurée');
  if (!(await canJoinLiveRoom(user.id, liveId))) throw forbidden('LIVE_ACCESS_DENIED', 'Accès à ce Live refusé');
  const live = await liveFor(liveId);
  requireLive(live);
  const decision = resolveVideoRole(live.hostId === user.id, await findParticipant(liveId, user.id));
  if (!decision.allowed) throw forbidden('LIVE_BLOCKED', 'Vous ne pouvez plus participer à ce Live');
  const room = liveRoomName(liveId);
  const token = signLivekitToken({
    apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET!, identity: user.id, name: user.displayName,
    ttlSeconds: TOKEN_TTL_SECONDS, video: videoGrantFor(decision.role, decision.canPublish, room),
  });
  return {
    provider: 'livekit', url: env.LIVEKIT_URL!, room, identity: user.id, role: decision.role, canPublish: decision.canPublish,
    token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
  };
}

/** Invitation d'un co-host : plafonné, jamais un utilisateur bloqué ; l'invité reçoit une notification. */
export async function inviteCoHost(host: User, liveId: string, userId: string) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  requireLive(live);
  if (userId === host.id) throw conflict('CANNOT_INVITE_SELF', 'Vous êtes déjà l’hôte de ce Live');
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!target || target.status === 'DELETED') throw notFound('Utilisateur introuvable');
  const existing = await findParticipant(liveId, userId);
  if (existing?.blockedAt) throw forbidden('PARTICIPANT_BLOCKED', 'Cet utilisateur est bloqué sur ce Live');
  if (existing?.acceptedAt && !existing.removedAt) throw conflict('ALREADY_COHOST', 'Cet utilisateur est déjà co-host');
  const alreadyPending = !!(existing?.invitedAt && !existing.acceptedAt && !existing.removedAt);
  if (!alreadyPending && (await countCoHostSlots(liveId)) >= LIVE_COHOST_LIMIT) throw conflict('COHOST_LIMIT', `Un Live accepte au plus ${LIVE_COHOST_LIMIT} co-hosts`);
  const now = new Date();
  const row = await prisma.liveParticipant.upsert({
    where: { liveId_userId: { liveId, userId } },
    create: { liveId, userId, invitedAt: now },
    update: { invitedAt: now, acceptedAt: null, removedAt: null, mutedAt: null },
  });
  await notify(prisma, { userId, type: 'LIVE_COHOST_INVITE', actorId: host.id, targetType: 'LIVE', targetId: liveId, pushPayload: { type: 'LIVE_COHOST_INVITE', liveId, username: host.username } });
  publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId, state: 'INVITED' } });
  return { participant: dto(userId, row) };
}

/** Réponse de l'invité : acceptation (droit de publier accordé, ou nouveau jeton si la connexion n'est pas active) ou refus. */
export async function respondCoHostInvite(user: User, liveId: string, accept: boolean) {
  const live = await liveFor(liveId);
  requireLive(live);
  const p = await findParticipant(liveId, user.id);
  if (!p || !p.invitedAt || p.acceptedAt || p.removedAt || p.blockedAt) throw conflict('NO_PENDING_INVITE', 'Aucune invitation en attente');
  const now = new Date();
  if (!accept) {
    const row = await prisma.liveParticipant.update({ where: { liveId_userId: { liveId, userId: user.id } }, data: { removedAt: now } });
    publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId: user.id, state: 'REMOVED' } });
    return { participant: dto(user.id, row) };
  }
  const row = await prisma.liveParticipant.update({ where: { liveId_userId: { liveId, userId: user.id } }, data: { acceptedAt: now, removedAt: null } });
  let applied = false;
  if (liveVideoConfigured()) { try { applied = await setPublishPermission(liveId, user.id, !row.mutedAt); } catch { applied = false; } }
  publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId: user.id, state: 'COHOST' } });
  return { participant: dto(user.id, row), mustReconnect: !applied };
}

/** Retrait d'un co-host : le droit de publier est retiré côté serveur vidéo avant l'enregistrement. */
export async function removeCoHost(host: User, liveId: string, userId: string) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  requireLive(live);
  const p = await findParticipant(liveId, userId);
  if (!p || !p.acceptedAt || p.removedAt) throw conflict('NOT_COHOST', 'Cet utilisateur n’est pas co-host');
  await enforcePublish(liveId, userId, false);
  const row = await prisma.liveParticipant.update({ where: { liveId_userId: { liveId, userId } }, data: { removedAt: new Date() } });
  publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId, state: 'REMOVED' } });
  return { participant: dto(userId, row) };
}

/** Mise en sourdine d'un co-host : retire ou rend le droit de publier, côté serveur vidéo d'abord. */
export async function setMuted(host: User, liveId: string, userId: string, muted: boolean) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  requireLive(live);
  const p = await findParticipant(liveId, userId);
  if (!p || !p.acceptedAt || p.removedAt) throw conflict('NOT_COHOST', 'Seul un co-host peut être rendu muet');
  await enforcePublish(liveId, userId, !muted);
  const row = await prisma.liveParticipant.update({ where: { liveId_userId: { liveId, userId } }, data: { mutedAt: muted ? new Date() : null } });
  publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId, state: 'COHOST', muted } });
  return { participant: dto(userId, row) };
}

/** Blocage : enregistré d'abord (plus de jeton, plus de chat), puis expulsion de la salle (au mieux). */
export async function blockParticipant(host: User, liveId: string, userId: string) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  if (userId === host.id) throw conflict('CANNOT_BLOCK_SELF', 'Vous ne pouvez pas vous bloquer');
  const now = new Date();
  const row = await prisma.liveParticipant.upsert({
    where: { liveId_userId: { liveId, userId } },
    create: { liveId, userId, blockedAt: now, removedAt: now },
    update: { blockedAt: now, removedAt: now, mutedAt: null },
  });
  let removedFromRoom = false;
  if (liveVideoConfigured()) { try { removedFromRoom = await removeFromRoom(liveId, userId); } catch { removedFromRoom = false; } }
  publishToRoom(liveId, { type: 'LIVE_COHOST_UPDATE', payload: { liveId, userId, state: 'BLOCKED' } });
  return { participant: dto(userId, row), removedFromRoom };
}

/** Suppression d'un message du chat par l'hôte : disparaît pour tous, via un événement temps réel. */
export async function deleteChatMessage(user: User, liveId: string, messageId: string) {
  const live = await liveFor(liveId);
  requireHost(user, live);
  const msg = await prisma.liveChatMessage.findFirst({ where: { id: messageId, liveId, deletedAt: null } });
  if (!msg) throw notFound('Message introuvable');
  await prisma.liveChatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
  publishToRoom(liveId, { type: 'LIVE_CHAT_DELETED', payload: { liveId, messageId } });
  return { id: messageId, deleted: true };
}

/** Bilan du Live pour l'hôte : durée, spectateurs, interactions, abonnés gagnés pendant le Live, cadeaux et pourboires. */
export async function liveReport(user: User, liveId: string) {
  const live = await prisma.live.findFirst({ where: { id: liveId, moderationStatus: 'ACTIVE' } });
  if (!live) throw notFound('Live introuvable');
  if (live.hostId !== user.id) throw forbidden('LIVE_FORBIDDEN', 'Réservé à l’hôte du Live');
  if (live.status === 'SCHEDULED') throw conflict('LIVE_NOT_STARTED', 'Ce Live n’a pas encore commencé');
  const end = live.endedAt ?? new Date();
  const start = live.startedAt ?? end;
  const [gifts, tips, followers, coHosts] = await Promise.all([
    prisma.coinGiftTransaction.aggregate({ where: { liveId }, _count: { _all: true }, _sum: { creatorAmount: true } }),
    prisma.coinTipTransaction.aggregate({ where: { liveId }, _count: { _all: true }, _sum: { creatorAmount: true } }),
    prisma.follow.count({ where: { followingId: live.hostId, createdAt: { gte: start, lte: end } } }),
    prisma.liveParticipant.count({ where: { liveId, acceptedAt: { not: null } } }),
  ]);
  const giftsAmount = gifts._sum.creatorAmount ?? 0;
  const tipsAmount = tips._sum.creatorAmount ?? 0;
  return {
    liveId, title: live.title, status: live.status, startedAt: live.startedAt, endedAt: live.endedAt,
    durationSeconds: Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)),
    uniqueViewers: live.uniqueViewers, peakViewers: live.peakViewers, totalMessages: live.totalMessages, totalReactions: live.totalReactions,
    followersGained: followers, coHosts,
    gifts: { count: gifts._count._all, creatorAmount: giftsAmount },
    tips: { count: tips._count._all, creatorAmount: tipsAmount },
    revenue: giftsAmount + tipsAmount, currency: 'XAF',
  };
}

/** Co-hosts du Live (invitations en attente et co-hosts actifs), pour la modération de l'hôte. */
export async function listCoHosts(host: User, liveId: string) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  const rows = await prisma.liveParticipant.findMany({
    where: { liveId, removedAt: null, OR: [{ invitedAt: { not: null } }, { acceptedAt: { not: null } }] },
    orderBy: { updatedAt: 'desc' }, take: 20,
    include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  return { coHosts: rows.map((p) => ({ ...dto(p.userId, p), user: p.user })) };
}

/** État de l'utilisateur courant dans le Live : invitation, co-host, muet, bloqué. Pour afficher la bonne interface. */
export async function myParticipation(user: User, liveId: string) {
  const live = await liveFor(liveId);
  const p = await findParticipant(liveId, user.id);
  return { liveId, isHost: live.hostId === user.id, ...dto(user.id, p) };
}

/** Spectateurs présents (hôte seulement) : pour modérer aussi ceux qui n'écrivent pas dans le chat. */
export async function listViewers(host: User, liveId: string) {
  const live = await liveFor(liveId);
  requireHost(host, live);
  const where = { liveId, isActive: true, userId: { not: host.id } };
  const [viewers, count] = await Promise.all([
    prisma.liveViewer.findMany({
      where, orderBy: { joinedAt: 'desc' }, take: 100,
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    }),
    prisma.liveViewer.count({ where }),
  ]);
  const blocked = await prisma.liveParticipant.findMany({
    where: { liveId, blockedAt: { not: null }, userId: { in: viewers.map((v) => v.userId) } }, select: { userId: true },
  });
  const blockedSet = new Set(blocked.map((b) => b.userId));
  return {
    count,
    viewers: viewers.map((v) => ({ userId: v.userId, joinedAt: v.joinedAt, user: v.user, blocked: blockedSet.has(v.userId) })),
  };
}
