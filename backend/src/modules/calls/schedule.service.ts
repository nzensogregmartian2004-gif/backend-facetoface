import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { assertCallsConfigured } from '../../utils/callsGuard';
import { callProvider } from '../../utils/callProvider';
import { scheduleWindowError } from './schedule.rules';

export const scheduleSchema = z.object({
  creatorId: z.string().trim().min(1).max(64),
  type: z.enum(['AUDIO', 'VIDEO']),
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(120),
}).strict();

const party = { select: { id: true, username: true, displayName: true } } as const;

const WINDOW_MESSAGES = {
  TOO_SOON: 'Choisissez un créneau au moins 10 minutes à l’avance',
  TOO_FAR: 'Un créneau se réserve 60 jours à l’avance au plus',
  DURATION: 'Durée entre 5 et 120 minutes',
} as const;

/** Demande de créneau. Aucun paiement ici : les minutes se paient au démarrage de l'appel. */
export async function createSchedule(viewer: User, b: z.infer<typeof scheduleSchema>) {
  assertCallsConfigured(callProvider.configured());
  if (b.creatorId === viewer.id) throw badRequest('SELF_CALL', 'Vous ne pouvez pas planifier un appel avec vous-même');
  const creator = await prisma.user.findUnique({ where: { id: b.creatorId }, select: { id: true, status: true, isCreator: true } });
  if (!creator || creator.status !== 'ACTIVE' || !creator.isCreator) throw notFound('Créateur introuvable');
  const err = scheduleWindowError(b.startsAt, b.durationMinutes, new Date());
  if (err) throw badRequest('SCHEDULE_WINDOW', WINDOW_MESSAGES[err as keyof typeof WINDOW_MESSAGES] ?? 'Créneau invalide');
  return prisma.scheduledCall.create({
    data: { callerId: viewer.id, creatorId: b.creatorId, type: b.type, startsAt: b.startsAt, durationMinutes: b.durationMinutes },
    select: { id: true, type: true, startsAt: true, durationMinutes: true, status: true },
  });
}

/** Mes appels planifiés, comme client ou comme créateur, du plus proche au plus lointain. */
export async function listSchedules(viewer: User) {
  const rows = await prisma.scheduledCall.findMany({
    where: { OR: [{ callerId: viewer.id }, { creatorId: viewer.id }] },
    orderBy: { startsAt: 'asc' }, take: 100,
    select: { id: true, type: true, startsAt: true, durationMinutes: true, status: true, callerId: true, creatorId: true, caller: party, creator: party },
  });
  return rows.map((r) => ({
    id: r.id, type: r.type, startsAt: r.startsAt, durationMinutes: r.durationMinutes, status: r.status,
    direction: r.creatorId === viewer.id ? 'INCOMING' as const : 'OUTGOING' as const,
    other: r.creatorId === viewer.id ? r.caller : r.creator,
  }));
}

/** Le créateur accepte ou refuse une demande en attente, avant le créneau. */
export async function respondSchedule(viewer: User, id: string, accept: boolean) {
  const s = await prisma.scheduledCall.findUnique({ where: { id }, select: { id: true, creatorId: true, status: true, startsAt: true } });
  if (!s) throw notFound('Appel planifié introuvable');
  if (s.creatorId !== viewer.id) throw forbidden('NOT_CREATOR', 'Seul le créateur répond à une demande');
  if (s.status !== 'PENDING') throw conflict('SCHEDULE_NOT_PENDING', 'Cette demande n’est plus en attente');
  if (s.startsAt.getTime() <= Date.now()) throw badRequest('SCHEDULE_PAST', 'Ce créneau est déjà passé');
  return prisma.scheduledCall.update({ where: { id }, data: { status: accept ? 'ACCEPTED' : 'DECLINED' }, select: { id: true, status: true } });
}

/** Annulation par le client ou le créateur, tant que le créneau n'a pas commencé. */
export async function cancelSchedule(viewer: User, id: string) {
  const s = await prisma.scheduledCall.findUnique({ where: { id }, select: { id: true, callerId: true, creatorId: true, status: true, startsAt: true } });
  if (!s) throw notFound('Appel planifié introuvable');
  if (s.callerId !== viewer.id && s.creatorId !== viewer.id) throw forbidden('NOT_PARTY', 'Vous ne participez pas à cet appel');
  if (s.status !== 'PENDING' && s.status !== 'ACCEPTED') throw conflict('SCHEDULE_CLOSED', 'Cet appel ne peut plus être annulé');
  if (s.startsAt.getTime() <= Date.now()) throw badRequest('SCHEDULE_PAST', 'Ce créneau a déjà commencé');
  return prisma.scheduledCall.update({ where: { id }, data: { status: 'CANCELLED' }, select: { id: true, status: true } });
}
