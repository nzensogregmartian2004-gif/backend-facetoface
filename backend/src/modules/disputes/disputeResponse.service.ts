import { prisma } from '../../config/db';
import { conflict, notFound } from '../../utils/errors';
import { getConfigValue } from '../config/config.service';
import { DISPUTE_RESPONSE_DAYS_DEFAULT, canRespondToDispute, disputeDeadline } from './deadlines.rules';

/** Délai de réponse des litiges, en jours. Modifiable par les administrateurs (réglage DISPUTES.RESPONSE_DAYS). */
export async function disputeResponseDays(): Promise<number> {
  const v = await getConfigValue<number>('DISPUTES.RESPONSE_DAYS', DISPUTE_RESPONSE_DAYS_DEFAULT);
  return typeof v === 'number' && v > 0 ? v : DISPUTE_RESPONSE_DAYS_DEFAULT;
}

/** Le créateur (appelé) répond à un litige d'appel, une seule fois, avant l'échéance. */
export async function respondToCallDispute(userId: string, callId: string, response: string) {
  const c = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, calleeId: true, disputedAt: true, disputeClosedAt: true, disputeRespondedAt: true } });
  if (!c || c.calleeId !== userId || !c.disputedAt) throw notFound('Litige introuvable');
  if (!canRespondToDispute(c, new Date(), await disputeResponseDays())) throw conflict('DISPUTE_RESPONSE_CLOSED', 'La réponse à ce litige n’est plus possible');
  return prisma.call.update({ where: { id: callId }, data: { disputeResponse: response, disputeRespondedAt: new Date() }, select: { id: true, disputeRespondedAt: true } });
}

/** Le créateur répond à un litige de vidéo personnalisée, une seule fois, avant l'échéance. */
export async function respondToCustomVideoDispute(userId: string, id: string, response: string) {
  const r = await prisma.customVideoRequest.findUnique({ where: { id }, select: { id: true, creatorId: true, status: true, disputedAt: true, disputeClosedAt: true, disputeRespondedAt: true } });
  if (!r || r.creatorId !== userId || r.status !== 'DISPUTED') throw notFound('Litige introuvable');
  if (!canRespondToDispute(r, new Date(), await disputeResponseDays())) throw conflict('DISPUTE_RESPONSE_CLOSED', 'La réponse à ce litige n’est plus possible');
  return prisma.customVideoRequest.update({ where: { id }, data: { disputeResponse: response, disputeRespondedAt: new Date() }, select: { id: true, disputeRespondedAt: true } });
}

/** Clôture sans montant les litiges sans réponse dont le délai est dépassé. Ne touche à aucun montant. */
export async function closeExpiredDisputes(now = new Date()) {
  const days = await disputeResponseDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const calls = await prisma.call.updateMany({ where: { disputedAt: { lt: cutoff }, disputeClosedAt: null, disputeRespondedAt: null }, data: { disputeClosedAt: now } });
  const videos = await prisma.customVideoRequest.updateMany({ where: { status: 'DISPUTED', disputedAt: { lt: cutoff }, disputeClosedAt: null, disputeRespondedAt: null }, data: { disputeClosedAt: now } });
  return { calls: calls.count, customVideos: videos.count };
}

/** Marque un litige comme clos après la décision de l'administration. */
export async function markDisputeClosed(type: 'CALL' | 'CUSTOM_VIDEO', id: string, now = new Date()) {
  if (type === 'CALL') await prisma.call.updateMany({ where: { id, disputedAt: { not: null }, disputeClosedAt: null }, data: { disputeClosedAt: now } });
  else await prisma.customVideoRequest.updateMany({ where: { id, disputedAt: { not: null }, disputeClosedAt: null }, data: { disputeClosedAt: now } });
}

type DisputeRow = { id: string; disputeReason: string | null; disputedAt: Date | null; disputeResponse: string | null; disputeRespondedAt: Date | null; disputeClosedAt: Date | null };

/** Litiges qui concernent le créateur : appels reçus et vidéos personnalisées vendues, avec l'échéance de réponse. */
export async function listMyDisputes(userId: string, now = new Date()) {
  const days = await disputeResponseDays();
  const select = { id: true, disputeReason: true, disputedAt: true, disputeResponse: true, disputeRespondedAt: true, disputeClosedAt: true } as const;
  const [calls, videos] = await Promise.all([
    prisma.call.findMany({ where: { calleeId: userId, disputedAt: { not: null } }, orderBy: { disputedAt: 'desc' }, take: 50, select }),
    prisma.customVideoRequest.findMany({ where: { creatorId: userId, disputedAt: { not: null } }, orderBy: { disputedAt: 'desc' }, take: 50, select }),
  ]);
  const map = (type: 'CALL' | 'CUSTOM_VIDEO', rows: DisputeRow[]) => rows.map((r) => ({
    type, id: r.id, reason: r.disputeReason, openedAt: r.disputedAt!, deadline: disputeDeadline(r.disputedAt!, days),
    response: r.disputeResponse, respondedAt: r.disputeRespondedAt, closedAt: r.disputeClosedAt,
    canRespond: canRespondToDispute(r, now, days),
  }));
  return { responseDays: days, disputes: [...map('CALL', calls), ...map('CUSTOM_VIDEO', videos)] };
}
