import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { splitRecord } from '../../utils/money';
import { assertMobileMoneyCurrency, assertPriceInRange, DEFAULT_CURRENCY } from '../../utils/currency';
import { objectStorage } from '../../utils/objectStorage';
import { payments, type MobileOperator } from '../../utils/payments';
import { randomToken } from '../../utils/crypto';
import { messagingPermission } from './permission';
import { recordCreatorEarning } from '../monetization/monetization.service';
import { notify } from '../notifications/notifications.service';
import { loadMessageConversation } from './attachments.internal';

export const ATTACHMENT_MIME: Record<string, { kind: 'PHOTO'|'VIDEO'|'AUDIO'|'PDF'|'DOCUMENT'|'ZIP'|'VOICE'; ext: string }> = {
  'image/jpeg': { kind: 'PHOTO', ext: 'jpg' }, 'image/png': { kind: 'PHOTO', ext: 'png' }, 'image/webp': { kind: 'PHOTO', ext: 'webp' },
  'video/mp4': { kind: 'VIDEO', ext: 'mp4' }, 'video/quicktime': { kind: 'VIDEO', ext: 'mov' }, 'video/webm': { kind: 'VIDEO', ext: 'webm' },
  'audio/mpeg': { kind: 'AUDIO', ext: 'mp3' }, 'audio/mp4': { kind: 'AUDIO', ext: 'm4a' }, 'audio/aac': { kind: 'AUDIO', ext: 'aac' }, 'audio/ogg': { kind: 'AUDIO', ext: 'ogg' }, 'audio/webm': { kind: 'AUDIO', ext: 'webm' },
  'application/pdf': { kind: 'PDF', ext: 'pdf' }, 'application/zip': { kind: 'ZIP', ext: 'zip' }, 'application/x-zip-compressed': { kind: 'ZIP', ext: 'zip' },
  'application/msword': { kind: 'DOCUMENT', ext: 'doc' }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'DOCUMENT', ext: 'docx' },
  'application/vnd.ms-excel': { kind: 'DOCUMENT', ext: 'xls' }, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'DOCUMENT', ext: 'xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'DOCUMENT', ext: 'ppt' }, 'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'DOCUMENT', ext: 'pptx' },
  'text/plain': { kind: 'DOCUMENT', ext: 'txt' },
};

const maxFor = (kind: string) => kind === 'VIDEO' ? env.MESSAGE_VIDEO_MAX_BYTES : kind === 'AUDIO' || kind === 'VOICE' ? env.MESSAGE_AUDIO_MAX_BYTES : env.MESSAGE_ATTACHMENT_MAX_BYTES;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const reference = () => `A${randomToken(11)}`.slice(0, 13);

export async function requestUpload(viewer: User, b: { conversationId: string; contentType: string; sizeBytes: number; kind?: string }) {
  const meta = ATTACHMENT_MIME[b.contentType];
  if (!meta) throw badRequest('UNSUPPORTED_ATTACHMENT', 'Format non pris en charge');
  const { other, conv } = await loadMessageConversation(viewer, b.conversationId);
  if (conv.isGroup) {
    if (!conv.allowPaidContent && b.kind) { /* paid state is checked at message creation; upload itself stays allowed */ }
  } else {
    const perm = await messagingPermission(viewer, other!);
    if (!perm.allowed) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
  }
  const kind = b.kind === 'VOICE' ? 'VOICE' : meta.kind;
  if (kind === 'VOICE' && !b.contentType.startsWith('audio/')) throw badRequest('INVALID_VOICE', 'Un vocal doit être un fichier audio');
  if (b.sizeBytes > maxFor(kind)) throw badRequest('FILE_TOO_LARGE', 'Fichier trop volumineux');
  const key = `messages/${b.conversationId}/${viewer.id}/attachments/${randomToken(10)}.${meta.ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key, kind } };
}

export async function unlock(viewer: User, attachmentId: string, input: { operator: MobileOperator; phone: string }) {
  const a = await prisma.attachment.findUnique({ where: { id: attachmentId }, include: { message: true } });
  if (!a || a.message.deletedAt || a.price == null) throw notFound('Pièce jointe introuvable');
  const { other } = await loadMessageConversation(viewer, a.message.conversationId);
  if (!other) throw notFound('Pièce jointe introuvable');
  const perm = await messagingPermission(viewer, other);
  if (!perm.allowed && perm.reason === 'BLOCKED') throw notFound('Pièce jointe introuvable');
  if (other && (other.id !== a.message.senderId || a.message.senderId === viewer.id)) throw notFound('Pièce jointe introuvable');
  if (!payments.operators().includes(input.operator)) { if (!payments.operators().length) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur'); throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible"); }
  const existing = await prisma.attachmentPurchase.findUnique({ where: { attachmentId_buyerId: { attachmentId, buyerId: viewer.id } } });
  if (existing?.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, alreadyPurchased: true };
  if (existing?.status === 'PENDING') throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours', { purchaseId: existing.id });
  if (existing?.status === 'REVIEW') throw conflict('PAYMENT_UNDER_REVIEW', 'Votre paiement est en cours de vérification', { purchaseId: existing.id });
  const currency = a.currency ?? DEFAULT_CURRENCY; assertMobileMoneyCurrency(currency);
  const split = splitRecord(a.price, env.PAID_MESSAGE_COMMISSION_BPS, currency); const ref = reference();
  let id: string;
  if (existing) {
    const r = await prisma.attachmentPurchase.updateMany({ where: { id: existing.id, status: 'FAILED' }, data: { status: 'PENDING', attempts: { increment: 1 }, ...split, reference: ref, initiatedAt: new Date(), operator: input.operator, payerPhoneHint: input.phone.slice(-4), externalRef: null, paidAt: null, reviewReason: null, providerPayload: Prisma.DbNull } });
    if (!r.count) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours'); id = existing.id;
  } else {
    try { id = (await prisma.attachmentPurchase.create({ data: { attachmentId, buyerId: viewer.id, sellerId: a.message.senderId, ...split, reference: ref, operator: input.operator, payerPhoneHint: input.phone.slice(-4) } })).id; }
    catch (e) { if (isUnique(e)) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours'); throw e; }
  }
  const fail = () => prisma.attachmentPurchase.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED' } });
  let res; try { res = await payments.initiate({ reference: ref, amount: split.grossAmount, currency, operator: input.operator, phone: input.phone, description: 'Pièce jointe payante' }); } catch (e) { await fail(); throw e; }
  if (res.status === 'REJECTED') { await fail(); throw new AppError(402, 'PAYMENT_FAILED', res.message || 'Le paiement a été refusé'); }
  if (res.status === 'ACCEPTED' && res.providerRef) await prisma.attachmentPurchase.updateMany({ where: { id, status: 'PENDING' }, data: { externalRef: res.providerRef } });
  const now = await prisma.attachmentPurchase.findUniqueOrThrow({ where: { id } });
  return { httpStatus: 202 as const, status: 'PENDING' as const, purchase: viewPurchase(now) };
}

const viewPurchase = (p: any) => ({ id: p.id, status: p.status, operator: p.operator, price: p.grossAmount, currency: p.currency, initiatedAt: p.initiatedAt, review: p.status === 'REVIEW' });

export async function getPurchase(viewer: User, purchaseId: string) {
  const p = await prisma.attachmentPurchase.findUnique({ where: { id: purchaseId } });
  if (!p || p.buyerId !== viewer.id) throw notFound('Achat introuvable');
  return { purchase: viewPurchase(p), unlocked: p.status === 'PAID' };
}

export async function settle(referenceId: string, status: 'SUCCESS'|'FAILED', amount?: number, providerRef?: string, payload?: unknown) {
  return prisma.$transaction(async tx => {
    const p = await tx.attachmentPurchase.findUnique({ where: { reference: referenceId } }); if (!p) return 'unknown'; if (p.status === 'PAID') return 'already';
    if (status === 'SUCCESS') {
      if (amount !== undefined && amount < p.grossAmount) { await tx.attachmentPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING','REVIEW'] } }, data: { status:'REVIEW', reviewReason:'AMOUNT_MISMATCH', providerPayload: payload as any } }); return 'review'; }
      const r = await tx.attachmentPurchase.updateMany({ where:{id:p.id,status:{in:['PENDING','REVIEW']}}, data:{status:'PAID',paidAt:new Date(),method:p.operator??'mobile_money',externalRef:providerRef??p.externalRef,providerPayload:payload as any,reviewReason:null} });
      if (!r.count) return 'already';
      await recordCreatorEarning(tx,{creatorId:p.sellerId,source:'ATTACHMENT',sourceId:p.id,grossAmount:p.grossAmount,currency:p.currency,commissionBps:p.commissionBps,status:'AVAILABLE'});
      const a = await tx.attachment.findUnique({ where: { id: p.attachmentId }, select: { message: { select: { conversationId: true } } } });
      await notify(tx, { userId: p.sellerId, type: 'MESSAGE_PURCHASED', actorId: p.buyerId, targetType: 'CONVERSATION', targetId: a?.message.conversationId, amount: p.creatorAmount, currency: p.currency });
      return 'paid';
    }
    const r=await tx.attachmentPurchase.updateMany({where:{id:p.id,status:{in:['PENDING','REVIEW']}},data:{status:'FAILED',providerPayload:payload as any}}); return r.count?'failed':'already';
  });
}
