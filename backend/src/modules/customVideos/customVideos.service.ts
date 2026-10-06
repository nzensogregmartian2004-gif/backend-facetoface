import { randomBytes } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { payments, type MobileOperator } from '../../utils/payments';
import { splitAmount } from '../../utils/money';
import { objectStorage } from '../../utils/objectStorage';
import { recordCreatorEarning } from '../monetization/monetization.service';
import { notify } from '../notifications/notifications.service';

const newReference = () => `V${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();
const creator = async (id: string) => {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u || u.status !== 'ACTIVE' || !u.isCreator) throw notFound('Créateur introuvable');
  return u;
};
const view = (r: any) => ({
  id: r.id, buyerId: r.buyerId, creatorId: r.creatorId, requestText: r.requestText, priceFcfa: r.priceFcfa, currency: r.currency,
  deadlineAt: r.deadlineAt, status: r.status, acceptedAt: r.acceptedAt, declinedAt: r.declinedAt, cancelledAt: r.cancelledAt,
  deliveredAt: r.deliveredAt, completedAt: r.completedAt, disputedAt: r.disputedAt, disputeReason: r.disputeReason,
  hasVideo: !!r.videoKey, durationSeconds: r.durationSeconds, createdAt: r.createdAt, updatedAt: r.updatedAt,
  buyer: r.buyer ? { id: r.buyer.id, username: r.buyer.username, displayName: r.buyer.displayName, avatarUrl: r.buyer.avatarUrl } : undefined,
  creator: r.creator ? { id: r.creator.id, username: r.creator.username, displayName: r.creator.displayName, avatarUrl: r.creator.avatarUrl } : undefined,
});
const load = async (id: string) => prisma.customVideoRequest.findUnique({ where: { id }, include: { buyer: true, creator: true } });

export async function createRequest(buyer: User, creatorId: string, input: { requestText: string }) {
  if (buyer.id === creatorId) throw badRequest('SELF_REQUEST', 'Vous ne pouvez pas commander une vidéo à vous-même');
  await creator(creatorId);
  const active = await prisma.customVideoRequest.findFirst({ where: { buyerId: buyer.id, creatorId, status: { in: ['REQUESTED','AWAITING_PAYMENT','PAYMENT_PENDING','PAYMENT_REVIEW','AWAITING_CREATOR','ACCEPTED','IN_PROGRESS','DELIVERED','DISPUTED'] } }, select: { id: true } });
  if (active) throw conflict('CUSTOM_VIDEO_IN_PROGRESS', 'Une demande est déjà en cours avec ce créateur', { requestId: active.id });
  const r = await prisma.customVideoRequest.create({ data: { buyerId: buyer.id, creatorId, requestText: input.requestText, currency: 'XAF' }, include: { buyer: true, creator: true } });
  await prisma.notification.create({ data: { userId: creatorId, type: 'CUSTOM_VIDEO_REQUESTED', actorId: buyer.id, targetType: 'CUSTOM_VIDEO', targetId: r.id } });
  return { request: view(r) };
}

export async function listMine(user: User) {
  const rows = await prisma.customVideoRequest.findMany({ where: { buyerId: user.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { buyer: true, creator: true } });
  return { requests: rows.map(view) };
}
export async function listCreator(user: User) {
  if (!user.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur');
  const rows = await prisma.customVideoRequest.findMany({ where: { creatorId: user.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { buyer: true, creator: true } });
  return { requests: rows.map(view) };
}
export async function getOne(user: User, id: string) {
  const r = await load(id);
  if (!r || (r.buyerId !== user.id && r.creatorId !== user.id)) throw notFound('Demande introuvable');
  return { request: view(r) };
}

export async function offer(user: User, id: string, input: { priceFcfa: number; deadlineDays: number }) {
  const r = await load(id);
  if (!r || r.creatorId !== user.id) throw notFound('Demande introuvable');
  if (r.status !== 'REQUESTED') throw conflict('INVALID_STATUS', 'Cette demande ne peut plus recevoir de proposition');
  if (input.priceFcfa < env.CUSTOM_VIDEO_MIN_FCFA || input.priceFcfa > env.CUSTOM_VIDEO_MAX_FCFA) throw badRequest('INVALID_CUSTOM_VIDEO_PRICE', `Le prix doit être compris entre ${env.CUSTOM_VIDEO_MIN_FCFA} et ${env.CUSTOM_VIDEO_MAX_FCFA} FCFA`);
  const deadlineAt = new Date(Date.now() + input.deadlineDays * 86400_000);
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { priceFcfa: input.priceFcfa, deadlineAt, status: 'AWAITING_PAYMENT' }, include: { buyer: true, creator: true } });
  return { request: view(u) };
}

export async function pay(user: User, id: string, input: { operator: MobileOperator; phone: string }) {
  const r = await load(id);
  if (!r || r.buyerId !== user.id) throw notFound('Demande introuvable');
  if (r.status !== 'AWAITING_PAYMENT' || !r.priceFcfa) throw conflict('PAYMENT_NOT_AVAILABLE', 'Le paiement n’est pas disponible pour cette demande');
  if (r.deadlineAt && r.deadlineAt <= new Date()) throw conflict('REQUEST_EXPIRED', 'Le délai proposé est déjà dépassé');
  if (!payments.operators().includes(input.operator)) {
    if (!payments.operators().length) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible");
  }
  const split = splitAmount(r.priceFcfa, env.CUSTOM_VIDEO_COMMISSION_BPS);
  const reference = newReference();
  const payment = await prisma.customVideoPayment.create({ data: { requestId: r.id, buyerId: user.id, creatorId: r.creatorId, grossFcfa: split.grossAmount, commissionFcfa: split.platformFeeAmount, creatorFcfa: split.creatorAmount, commissionBps: split.commissionBps, reference, operator: input.operator, payerPhoneHint: input.phone.slice(-4) } });
  await prisma.customVideoRequest.update({ where: { id: r.id }, data: { status: 'PAYMENT_PENDING' } });
  let result;
  try { result = await payments.initiate({ reference, amountFcfa: split.grossAmount, operator: input.operator, phone: input.phone, description: 'Vidéo personnalisée Face to Face' }); }
  catch (e) { await prisma.customVideoPayment.update({ where: { id: payment.id }, data: { status: 'FAILED' } }); await prisma.customVideoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT' } }); throw e; }
  if (result.status === 'REJECTED') { await prisma.customVideoPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', reviewReason: result.code } }); await prisma.customVideoRequest.update({ where: { id: r.id }, data: { status: 'AWAITING_PAYMENT' } }); throw new AppError(402, 'PAYMENT_FAILED', result.message || 'Le paiement a été refusé'); }
  if (result.status === 'ACCEPTED' && result.providerRef) await prisma.customVideoPayment.update({ where: { id: payment.id }, data: { externalRef: result.providerRef } });
  const now = await load(id);
  return { httpStatus: 202 as const, request: view(now), payment: { id: payment.id, status: 'PENDING', reference } };
}

export async function settleCustomVideoPayment(reference: string, outcome: { status: 'SUCCESS'|'FAILED'; amountFcfa?: number; providerRef?: string; payload?: unknown }) {
  return prisma.$transaction(async tx => {
    const p = await tx.customVideoPayment.findUnique({ where: { reference }, include: { request: true } });
    if (!p) return 'unknown' as const;
    if (p.status === 'PAID') return 'already' as const;
    const payload = outcome.payload === undefined ? undefined : JSON.parse(JSON.stringify(outcome.payload));
    if (outcome.status === 'SUCCESS') {
      if (p.status === 'FAILED') { await tx.customVideoPayment.update({ where: { id: p.id }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } }); await tx.customVideoRequest.update({ where: { id: p.requestId }, data: { status: 'PAYMENT_REVIEW' } }); return 'review' as const; }
      if (outcome.amountFcfa !== undefined && outcome.amountFcfa < p.grossFcfa) { await tx.customVideoPayment.update({ where: { id: p.id }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } }); await tx.customVideoRequest.update({ where: { id: p.requestId }, data: { status: 'PAYMENT_REVIEW' } }); return 'review' as const; }
      const r = await tx.customVideoPayment.updateMany({ where: { id: p.id, status: { in: ['PENDING','REVIEW'] } }, data: { status: 'PAID', paidAt: new Date(), providerPayload: payload, ...(outcome.providerRef ? { externalRef: outcome.providerRef } : {}) } });
      if (r.count !== 1) return 'already' as const;
      await tx.customVideoRequest.update({ where: { id: p.requestId }, data: { status: 'AWAITING_CREATOR' } });
      await notify(tx, { userId: p.creatorId, type: 'CUSTOM_VIDEO_PAYMENT_CONFIRMED', actorId: p.buyerId, targetType: 'CUSTOM_VIDEO', targetId: p.requestId, amountFcfa: p.grossFcfa });
      return 'paid' as const;
    }
    const r = await tx.customVideoPayment.updateMany({ where: { id: p.id, status: { in: ['PENDING','REVIEW'] } }, data: { status: 'FAILED', providerPayload: payload } });
    if (r.count === 1) await tx.customVideoRequest.updateMany({ where: { id: p.requestId, status: 'PAYMENT_PENDING' }, data: { status: 'AWAITING_PAYMENT' } });
    return r.count === 1 ? 'failed' as const : 'already' as const;
  });
}

export async function accept(user: User, id: string) {
  const r = await load(id); if (!r || r.creatorId !== user.id) throw notFound('Demande introuvable');
  if (r.status !== 'AWAITING_CREATOR') throw conflict('INVALID_STATUS', 'La demande doit être payée avant acceptation');
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { status: 'ACCEPTED', acceptedAt: new Date() }, include: { buyer: true, creator: true } });
  return { request: view(u) };
}
export async function decline(user: User, id: string) {
  const r = await load(id); if (!r || r.creatorId !== user.id) throw notFound('Demande introuvable');
  if (r.status !== 'AWAITING_CREATOR') throw conflict('INVALID_STATUS', 'Cette demande ne peut pas être refusée');
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { status: 'REFUND_DUE', declinedAt: new Date(), refundDueAt: new Date() }, include: { buyer: true, creator: true } });
  await prisma.notification.create({ data: { userId: r.buyerId, type: 'CUSTOM_VIDEO_DECLINED', actorId: user.id, targetType: 'CUSTOM_VIDEO', targetId: id } });
  return { request: view(u), refund: { status: 'DUE' as const } };
}
export async function cancel(user: User, id: string) {
  const r = await load(id); if (!r || r.buyerId !== user.id) throw notFound('Demande introuvable');
  if (!['REQUESTED','AWAITING_PAYMENT'].includes(r.status)) throw conflict('CANNOT_CANCEL', 'Cette demande ne peut plus être annulée directement');
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include: { buyer: true, creator: true } });
  return { request: view(u) };
}

export async function uploadUrl(user: User, id: string, input: { contentType: string; sizeBytes: number }) {
  const r = await load(id); if (!r || r.creatorId !== user.id) throw notFound('Demande introuvable');
  if (!['ACCEPTED','IN_PROGRESS'].includes(r.status)) throw conflict('UPLOAD_NOT_AVAILABLE', 'La vidéo ne peut pas encore être livrée');
  if (input.sizeBytes > env.VIDEO_MAX_BYTES) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(env.VIDEO_MAX_BYTES / 1_048_576)} Mo maximum)`);
  const ext = ({ 'video/mp4':'mp4', 'video/quicktime':'mov', 'video/webm':'webm' } as Record<string,string>)[input.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', 'Format vidéo non pris en charge');
  const key = `custom-videos/${id}/delivery-${randomBytes(6).toString('hex')}.${ext}`;
  const upload = objectStorage.presignUpload(key, input.contentType, env.UPLOAD_URL_TTL_SECONDS);
  await prisma.customVideoRequest.update({ where: { id }, data: { videoKey: key, mimeType: input.contentType, sizeBytes: null, uploadedAt: null, status: 'IN_PROGRESS' } });
  return { upload: { ...upload, key } };
}
export async function completeUpload(user: User, id: string, input: { durationSeconds: number }) {
  const r = await load(id); if (!r || r.creatorId !== user.id) throw notFound('Demande introuvable');
  if (!['ACCEPTED','IN_PROGRESS'].includes(r.status) || !r.videoKey) throw conflict('UPLOAD_NOT_AVAILABLE', 'Aucun envoi de vidéo en cours');
  if (input.durationSeconds > env.CUSTOM_VIDEO_MAX_DURATION_SECONDS) throw badRequest('VIDEO_TOO_LONG', `Durée maximale : ${env.CUSTOM_VIDEO_MAX_DURATION_SECONDS} secondes`);
  const info = await objectStorage.head(r.videoKey);
  if (!info || info.size < 1 || info.size > env.VIDEO_MAX_BYTES) throw conflict('UPLOAD_MISSING', "La vidéo n'a pas été reçue par le stockage");
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { sizeBytes: info.size, durationSeconds: input.durationSeconds, uploadedAt: new Date(), deliveredAt: new Date(), status: 'DELIVERED' }, include: { buyer: true, creator: true } });
  await prisma.notification.create({ data: { userId: r.buyerId, type: 'CUSTOM_VIDEO_DELIVERED', actorId: user.id, targetType: 'CUSTOM_VIDEO', targetId: id } });
  return { request: view(u) };
}
export async function playback(user: User, id: string) {
  const r = await load(id); if (!r || (r.buyerId !== user.id && r.creatorId !== user.id)) throw notFound('Demande introuvable');
  if (!r.videoKey || !r.uploadedAt || !['DELIVERED','COMPLETED'].includes(r.status)) throw notFound('Vidéo indisponible');
  const ttl = env.PLAYBACK_URL_TTL_SECONDS;
  return { playback: { url: objectStorage.readUrl(r.videoKey, ttl), expiresAt: new Date(Date.now()+ttl*1000).toISOString() } };
}
export async function complete(user: User, id: string) {
  const r = await load(id); if (!r || r.buyerId !== user.id) throw notFound('Demande introuvable');
  if (r.status !== 'DELIVERED') throw conflict('INVALID_STATUS', 'La vidéo doit être livrée avant validation');
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() }, include: { buyer: true, creator: true } });
  const p = await prisma.customVideoPayment.findFirst({ where: { requestId: id, status: 'PAID' }, orderBy: { createdAt: 'desc' } });
  if (p) await recordCreatorEarning(prisma, { creatorId: p.creatorId, source: 'CUSTOM_VIDEO', sourceId: p.id, grossAmount: p.grossFcfa, currency: 'XAF', commissionBps: p.commissionBps, status: 'AVAILABLE' });
  await prisma.notification.create({ data: { userId: r.creatorId, type: 'CUSTOM_VIDEO_COMPLETED', actorId: user.id, targetType: 'CUSTOM_VIDEO', targetId: id } });
  return { request: view(u) };
}
export async function dispute(user: User, id: string, reason: string) {
  const r = await load(id); if (!r || r.buyerId !== user.id) throw notFound('Demande introuvable');
  if (!['DELIVERED','COMPLETED'].includes(r.status)) throw conflict('INVALID_STATUS', 'Cette demande ne peut pas encore faire l’objet d’un litige');
  const u = await prisma.customVideoRequest.update({ where: { id }, data: { status: 'DISPUTED', disputedAt: new Date(), disputeReason: reason }, include: { buyer: true, creator: true } });
  return { request: view(u) };
}
