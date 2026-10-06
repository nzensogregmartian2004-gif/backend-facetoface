import { Prisma, type Message, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { randomBytes } from 'node:crypto';
import { randomToken } from '../../utils/crypto';
import { decodeCursor, encodeCursor, readIdCursor, idCursor } from '../../utils/cursor';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { splitAmountFcfa } from '../../utils/money';
import { objectStorage } from '../../utils/objectStorage';
import { payments, type MobileOperator } from '../../utils/payments';
import { blockedIdsFor } from '../content/access';
import { markTargetRead, notify } from '../notifications/notifications.service';
import { toUserCards } from '../users/profile.service';
import { MESSAGE_IMAGE_MIME, MESSAGE_VIDEO_MIME } from './messages.schemas';
import { previewOf, serializeMessage, serializeMessages } from './messages.serializer';
import { messagingPermission, pairKey } from './permission';

const dropObject = async (key: string | null | undefined) => { if (key) { try { await objectStorage.delete(key); } catch { /* nettoyage au mieux */ } } };
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Paramètres publics de la messagerie (le mobile ne doit rien coder en dur). */
export const settings = () => ({
  maxChars: 2000,
  media: { enabled: env.MESSAGE_MEDIA_ENABLED, imageMaxBytes: env.MESSAGE_IMAGE_MAX_BYTES, videoMaxBytes: env.MESSAGE_VIDEO_MAX_BYTES, imageTypes: Object.keys(MESSAGE_IMAGE_MIME), videoTypes: Object.keys(MESSAGE_VIDEO_MIME) },
  paidMessages: { minFcfa: env.PAID_MESSAGE_MIN_FCFA, maxFcfa: env.PAID_MESSAGE_MAX_FCFA, commissionBps: env.PAID_MESSAGE_COMMISSION_BPS },
  /** Opérateurs Mobile Money utilisables (liste vide = paiements non configurés : le mobile masque le bouton « Débloquer »). */
  payments: { enabled: payments.operators().length > 0, operators: payments.operators(), feePayer: env.PAYMENT_FEE_PAYER },
});

/**
 * Charge une conversation pour `viewer`. 404 si : inconnue, `viewer` n'en est pas membre, l'autre compte est inactif,
 * ou un blocage existe dans un sens ou l'autre (l'historique est conservé et réapparaît au déblocage).
 */
async function loadConversation(viewer: User, id: string) {
  const conv = await prisma.conversation.findUnique({ where: { id }, include: { members: { include: { user: true } } } });
  const me = conv?.members.find((m) => m.userId === viewer.id);
  const other = conv?.members.find((m) => m.userId !== viewer.id);
  if (!conv || !me || !other || other.user.status !== 'ACTIVE') throw notFound('Conversation introuvable');
  const blocked = await prisma.block.findFirst({ where: { OR: [{ blockerId: viewer.id, blockedId: other.userId }, { blockerId: other.userId, blockedId: viewer.id }] }, select: { id: true } });
  if (blocked) throw notFound('Conversation introuvable');
  return { conv, me, other };
}

async function conversationDto(viewer: User, conv: { id: string; lastMessageAt: Date | null; lastMessageId: string | null }, me: { unreadCount: number }, otherUser: User, withPermission: boolean) {
  const [card] = await toUserCards(viewer, [otherUser]);
  const last = conv.lastMessageId ? await prisma.message.findUnique({ where: { id: conv.lastMessageId } }) : null;
  const purchased = last?.priceFcfa != null ? !!(await prisma.messagePurchase.findFirst({ where: { messageId: last.id, status: 'PAID', OR: [{ buyerId: viewer.id }, { sellerId: viewer.id }] }, select: { id: true } })) : false;
  const perm = withPermission ? await messagingPermission(viewer, otherUser) : null;
  return {
    id: conv.id, other: card, unreadCount: me.unreadCount, lastMessageAt: conv.lastMessageAt,
    lastMessage: previewOf(last, viewer, purchased),
    ...(perm ? { canSend: perm.allowed, sendBlockedReason: perm.allowed ? null : perm.reason } : {}),
  };
}

export async function openConversation(viewer: User, userId: string) {
  if (userId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Action impossible sur votre propre compte');
  const other = await prisma.user.findUnique({ where: { id: userId } });
  if (!other) throw notFound('Utilisateur introuvable');
  const perm = await messagingPermission(viewer, other);
  if (!perm.allowed && perm.reason !== 'NOT_ALLOWED') throw notFound('Utilisateur introuvable');
  const key = pairKey(viewer.id, other.id);
  let conv = await prisma.conversation.findUnique({ where: { pairKey: key }, include: { members: true } });
  if (!conv) {
    if (!perm.allowed) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
    try {
      conv = await prisma.conversation.create({ data: { pairKey: key, members: { create: [{ userId: viewer.id }, { userId: other.id }] } }, include: { members: true } });
    } catch (e) {
      if (!isUnique(e)) throw e;
      conv = await prisma.conversation.findUniqueOrThrow({ where: { pairKey: key }, include: { members: true } }); // ouverture simultanée par l'autre côté
    }
  }
  const me = conv.members.find((m) => m.userId === viewer.id)!;
  return { conversation: await conversationDto(viewer, conv, me, other, true) };
}

export async function getConversation(viewer: User, id: string) {
  const { conv, me, other } = await loadConversation(viewer, id);
  return { conversation: await conversationDto(viewer, conv, me, other.user, true) };
}

/** Boîte de réception : conversations ayant au moins un message, non masquées, sans compte inactif ni blocage ; plus récentes d'abord. */
export async function listConversations(viewer: User, o: { cursor?: string; limit: number }) {
  const blocked = await blockedIdsFor(viewer.id);
  const c = decodeCursor(o.cursor);
  if (c && (typeof c.t !== 'number' || typeof c.i !== 'string')) throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
  const t = c ? new Date(c.t as number) : null;
  const where: Prisma.ConversationWhereInput = {
    lastMessageAt: { not: null },
    members: { some: { userId: viewer.id, hiddenAt: null } },
    NOT: { members: { some: { userId: { not: viewer.id }, OR: [{ userId: { in: blocked } }, { user: { status: { not: 'ACTIVE' } } }] } } },
    ...(t ? { OR: [{ lastMessageAt: { lt: t } }, { lastMessageAt: t, id: { lt: String(c!.i) } }] } : {}),
  };
  const rows = await prisma.conversation.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: o.limit + 1, include: { members: { include: { user: true } } } });
  const page = rows.slice(0, o.limit);
  const lastIds = page.map((r) => r.lastMessageId).filter((x): x is string => !!x);
  const [lasts, cards] = await Promise.all([
    prisma.message.findMany({ where: { id: { in: lastIds }, moderationStatus: 'ACTIVE' } }),
    toUserCards(viewer, page.map((r) => r.members.find((m) => m.userId !== viewer.id)!.user)),
  ]);
  const paid = lasts.filter((m) => m.priceFcfa != null).map((m) => m.id);
  const bought = new Set((paid.length ? await prisma.messagePurchase.findMany({ where: { messageId: { in: paid }, status: 'PAID', OR: [{ buyerId: viewer.id }, { sellerId: viewer.id }] }, select: { messageId: true } }) : []).map((p) => p.messageId));
  const byId = new Map(lasts.map((m) => [m.id, m]));
  const items = page.map((r, i) => {
    const me = r.members.find((m) => m.userId === viewer.id)!;
    const last = r.lastMessageId ? byId.get(r.lastMessageId) ?? null : null;
    return { id: r.id, other: cards[i], unreadCount: me.unreadCount, lastMessageAt: r.lastMessageAt, lastMessage: previewOf(last, viewer, last ? bought.has(last.id) : false) };
  });
  const lastRow = page[page.length - 1];
  return { items, nextCursor: rows.length > o.limit && lastRow ? encodeCursor({ t: lastRow.lastMessageAt!.getTime(), i: lastRow.id }) : null };
}

/** Nombre de conversations contenant des messages non lus (pastille de l'icône Messages). */
export async function unreadConversations(viewer: User) {
  const blocked = await blockedIdsFor(viewer.id);
  return prisma.conversation.count({
    where: {
      members: { some: { userId: viewer.id, hiddenAt: null, unreadCount: { gt: 0 } } },
      NOT: { members: { some: { userId: { not: viewer.id }, OR: [{ userId: { in: blocked } }, { user: { status: { not: 'ACTIVE' } } }] } } },
    },
  });
}

/** Messages d'une conversation, du plus récent au plus ancien ; ceux antérieurs à « supprimer la conversation » sont masqués. */
export async function listMessages(viewer: User, id: string, o: { cursor?: string; limit: number }) {
  const { me } = await loadConversation(viewer, id);
  const cursorId = readIdCursor(o.cursor);
  const rows = await prisma.message.findMany({
    where: { conversationId: id, moderationStatus: 'ACTIVE', ...(me.clearedAt ? { createdAt: { gt: me.clearedAt } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const page = rows.slice(0, o.limit);
  return { items: await serializeMessages(page, viewer), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}

export async function requestMediaUpload(viewer: User, b: { conversationId: string; contentType: string; sizeBytes: number }) {
  if (!env.MESSAGE_MEDIA_ENABLED) throw forbidden('MEDIA_DISABLED', "L'envoi de médias est désactivé");
  const { other } = await loadConversation(viewer, b.conversationId);
  const perm = await messagingPermission(viewer, other.user);
  if (!perm.allowed) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
  const isImage = !!MESSAGE_IMAGE_MIME[b.contentType];
  const ext = MESSAGE_IMAGE_MIME[b.contentType] ?? MESSAGE_VIDEO_MIME[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', 'Format non pris en charge (images JPEG, PNG, WebP ; vidéos MP4, MOV, WebM)');
  const max = isImage ? env.MESSAGE_IMAGE_MAX_BYTES : env.MESSAGE_VIDEO_MAX_BYTES;
  if (b.sizeBytes > max) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(max / 1_048_576)} Mo maximum)`);
  const key = `messages/${b.conversationId}/${viewer.id}/${randomToken(9)}.${ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

type SendInput = { text?: string; mediaKey?: string; priceFcfa?: number; clientId?: string };

export async function sendMessage(viewer: User, conversationId: string, b: SendInput) {
  if (b.clientId) {
    const dup = await prisma.message.findUnique({ where: { senderId_clientId: { senderId: viewer.id, clientId: b.clientId } } });
    if (dup) return { created: false, message: (await serializeMessages([dup], viewer))[0] };
  }
  const { conv, other } = await loadConversation(viewer, conversationId);
  const perm = await messagingPermission(viewer, other.user);
  if (!perm.allowed) {
    const canReply = perm.reason === 'NOT_ALLOWED' && !!(await prisma.message.findFirst({ where:{conversationId, senderId:other.user.id}, select:{id:true} }));
    if (!canReply) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
  }

  if (b.priceFcfa != null) {
    if (!viewer.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur pour envoyer des messages payants');
    if (b.priceFcfa < env.PAID_MESSAGE_MIN_FCFA || b.priceFcfa > env.PAID_MESSAGE_MAX_FCFA) {
      throw badRequest('INVALID_PRICE', `Le prix doit être compris entre ${env.PAID_MESSAGE_MIN_FCFA} et ${env.PAID_MESSAGE_MAX_FCFA} FCFA`, { priceFcfa: 'Montant hors limites' });
    }
  }

  let media: { key: string; mime: string; size: number } | null = null;
  if (b.mediaKey) {
    if (!env.MESSAGE_MEDIA_ENABLED) throw forbidden('MEDIA_DISABLED', "L'envoi de médias est désactivé");
    // La clé doit avoir été émise par le serveur pour CET expéditeur et CETTE conversation, et n'être utilisée qu'une fois.
    if (!b.mediaKey.startsWith(`messages/${conversationId}/${viewer.id}/`)) throw badRequest('INVALID_MEDIA', 'Média invalide');
    const ext = b.mediaKey.split('.').pop() ?? '';
    const mime = Object.entries({ ...MESSAGE_IMAGE_MIME, ...MESSAGE_VIDEO_MIME }).find(([, e]) => e === ext)?.[0];
    if (!mime) throw badRequest('INVALID_MEDIA', 'Média invalide');
    if (await prisma.message.findFirst({ where: { mediaKey: b.mediaKey }, select: { id: true } })) throw conflict('MEDIA_ALREADY_USED', 'Ce média a déjà été envoyé');
    const info = await objectStorage.head(b.mediaKey);
    if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
    const max = MESSAGE_IMAGE_MIME[mime] ? env.MESSAGE_IMAGE_MAX_BYTES : env.MESSAGE_VIDEO_MAX_BYTES;
    if (info.size < 1 || info.size > max) { await dropObject(b.mediaKey); throw badRequest('FILE_TOO_LARGE', 'Fichier vide ou trop volumineux'); }
    if (info.contentType && info.contentType.toLowerCase() !== mime) { await dropObject(b.mediaKey); throw badRequest('TYPE_MISMATCH', 'Le type du fichier ne correspond pas'); }
    media = { key: b.mediaKey, mime, size: info.size };
  }

  const now = new Date();
  try {
    const msg = await prisma.$transaction(async (tx) => {
      const m = await tx.message.create({
        data: {
          conversationId, senderId: viewer.id, kind: media ? 'MEDIA' : 'TEXT', text: b.text || null,
          mediaKey: media?.key ?? null, mediaMime: media?.mime ?? null, mediaSize: media?.size ?? null,
          priceFcfa: b.priceFcfa ?? null, clientId: b.clientId ?? null, createdAt: now,
        },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: m.createdAt, lastMessageId: m.id } });
      await tx.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { hiddenAt: null, lastReadAt: now, unreadCount: 0 } });
      await tx.conversationMember.updateMany({ where: { conversationId, userId: other.userId }, data: { hiddenAt: null, unreadCount: { increment: 1 } } });
      await notify(tx, { userId: other.userId, type: 'NEW_MESSAGE', actorId: viewer.id, targetType: 'CONVERSATION', targetId: conversationId });
      return m;
    });
    return { created: true, message: (await serializeMessages([msg], viewer))[0] };
  } catch (e) {
    if (isUnique(e) && b.clientId) { // deux envois simultanés avec le même clientId : on renvoie le premier
      const dup = await prisma.message.findUnique({ where: { senderId_clientId: { senderId: viewer.id, clientId: b.clientId } } });
      if (dup) return { created: false, message: (await serializeMessages([dup], viewer))[0] };
    }
    throw e;
  }
}

export async function markRead(viewer: User, conversationId: string) {
  await loadConversation(viewer, conversationId);
  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { unreadCount: 0, lastReadAt: new Date() } });
    await markTargetRead(tx, viewer.id, 'NEW_MESSAGE', conversationId);
  });
}

/** « Supprimer la conversation » : disparaît de MA boîte et mon historique est effacé ; l'autre participant garde la sienne. Un nouveau message la fait réapparaître (vide de l'ancien historique). */
export async function hideConversation(viewer: User, conversationId: string) {
  const { me } = await loadConversation(viewer, conversationId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.update({ where: { id: me.id }, data: { hiddenAt: now, clearedAt: now, unreadCount: 0, lastReadAt: now } });
    await markTargetRead(tx, viewer.id, 'NEW_MESSAGE', conversationId);
  });
}

/** Suppression d'un message par son auteur, pour tous. Interdite si le message payant a été (ou est en cours d'être) acheté : l'acheteur a payé. */
export async function deleteMessage(viewer: User, id: string) {
  const m = await prisma.message.findUnique({ where: { id }, include: { conversation: { include: { members: true } } } });
  if (!m || m.senderId !== viewer.id) throw notFound('Message introuvable');
  if (m.deletedAt) return;
  if (m.priceFcfa != null && (await prisma.messagePurchase.findFirst({ where: { messageId: id, status: { in: ['PAID', 'PENDING', 'REVIEW'] } }, select: { id: true } }))) {
    throw conflict('MESSAGE_PURCHASED', 'Ce message payant a été acheté (ou un paiement est en cours) : il ne peut plus être supprimé');
  }
  await prisma.$transaction(async (tx) => {
    await tx.message.update({ where: { id }, data: { deletedAt: new Date(), text: null, mediaKey: null, mediaMime: null, mediaSize: null } });
    const rec = m.conversation.members.find((x) => x.userId !== viewer.id);
    if (rec && rec.unreadCount > 0 && (!rec.lastReadAt || m.createdAt > rec.lastReadAt)) {
      await tx.conversationMember.update({ where: { id: rec.id }, data: { unreadCount: { decrement: 1 } } });
    }
  });
  await dropObject(m.mediaKey);
}

/** Retire de la base tout le contenu envoyé par un compte qui se supprime (les achats sont conservés : traçabilité financière). */
export async function purgeSentMessages(userId: string) {
  const rows = await prisma.message.findMany({ where: { senderId: userId, deletedAt: null, mediaKey: { not: null } }, select: { mediaKey: true } });
  await prisma.message.updateMany({ where: { senderId: userId, deletedAt: null }, data: { deletedAt: new Date(), text: null, mediaKey: null, mediaMime: null, mediaSize: null } });
  await Promise.all(rows.map((r) => dropObject(r.mediaKey)));
}

/** Référence marchand : ≤ 13 caractères (exigence MyPVit), unique, non devinable. */
const newReference = () => `M${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();

/**
 * Achat d'un message payant — paiement ASYNCHRONE (Mobile Money). Réponses :
 *  - 200 `{ status: 'PAID', alreadyPurchased: true, message }` : déjà acheté, aucun nouveau débit ;
 *  - 202 `{ status: 'PENDING', purchase, message }` : demande envoyée, le client valide sur son téléphone ; le résultat arrive par webhook,
 *    l'application interroge `GET /api/messages/purchases/:id` ;
 *  - 402 : refus net du prestataire (aucun débit) ; 409 : paiement déjà en cours / à vérifier ; 502-503 : prestataire indisponible ou non configuré.
 * Garanties : une seule ligne par (message, acheteur) ; un nouvel essai n'est possible QUE après un échec définitif (jamais sur un paiement
 * dont le sort est inconnu : double débit) ; l'achat devient PAID uniquement par `settlePurchase` (webhook ou rapprochement).
 */
export async function unlockMessage(viewer: User, messageId: string, input: { operator: MobileOperator; phone: string }) {
  const m: Message | null = await prisma.message.findUnique({ where: { id: messageId } });
  if (!m) throw notFound('Message introuvable');
  const { other } = await loadConversation(viewer, m.conversationId); // 404 si non membre, bloqué ou inactif
  if (m.deletedAt || m.priceFcfa == null) throw notFound('Message introuvable');
  if (m.senderId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Vous ne pouvez pas acheter votre propre message');
  if (other.userId !== m.senderId) throw notFound('Message introuvable');
  if (!payments.operators().includes(input.operator)) {
    if (payments.operators().length === 0) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible", { operator: 'Opérateur indisponible' });
  }

  const existing = await prisma.messagePurchase.findUnique({ where: { messageId_buyerId: { messageId, buyerId: viewer.id } } });
  if (existing?.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, alreadyPurchased: true, message: serializeMessage(m, viewer, true) };
  if (existing?.status === 'PENDING') throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce message', { purchaseId: existing.id });
  if (existing?.status === 'REVIEW') throw conflict('PAYMENT_UNDER_REVIEW', 'Votre paiement est en cours de vérification : ne le renouvelez pas, vous serez notifié', { purchaseId: existing.id });

  const split = splitAmountFcfa(m.priceFcfa, env.PAID_MESSAGE_COMMISSION_BPS);
  const reference = newReference();
  const attempt = { reference, operator: input.operator, payerPhoneHint: input.phone.slice(-4), initiatedAt: new Date(), reviewReason: null, providerPayload: undefined };
  let purchaseId: string;
  if (existing) { // FAILED (échec définitif) : on reprend la ligne avec une nouvelle référence ; une seule requête peut la réclamer
    const claimed = await prisma.messagePurchase.updateMany({ where: { id: existing.id, status: 'FAILED' }, data: { status: 'PENDING', attempts: { increment: 1 }, externalRef: null, paidAt: null, ...split, ...attempt, providerPayload: Prisma.DbNull } });
    if (claimed.count !== 1) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce message');
    purchaseId = existing.id;
  } else {
    try {
      purchaseId = (await prisma.messagePurchase.create({ data: { messageId, buyerId: viewer.id, sellerId: m.senderId, ...split, reference, operator: input.operator, payerPhoneHint: attempt.payerPhoneHint } })).id;
    } catch (e) {
      if (isUnique(e)) throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce message');
      throw e;
    }
  }

  const fail = () => prisma.messagePurchase.updateMany({ where: { id: purchaseId, status: 'PENDING' }, data: { status: 'FAILED' } });
  let res;
  try {
    res = await payments.initiate({ reference, amountFcfa: split.grossFcfa, operator: input.operator, phone: input.phone, description: 'Message payant' });
  } catch (e) { // rien n'est parti chez le prestataire : échec définitif, nouvel essai possible
    await fail();
    throw e;
  }
  if (res.status === 'REJECTED') {
    await fail();
    throw new AppError(402, 'PAYMENT_FAILED', res.message || 'Le paiement a été refusé', { code: res.code });
  }
  // ACCEPTED, ou UNCERTAIN (demande peut-être arrivée : l'achat reste PENDING, résolu par le webhook ou le rapprochement — jamais rejoué).
  if (res.status === 'ACCEPTED' && res.providerRef) await prisma.messagePurchase.updateMany({ where: { id: purchaseId, status: 'PENDING' }, data: { externalRef: res.providerRef } });
  // Le webhook a pu arriver avant cette ligne (paiement très rapide) : on relit l'état réel.
  const now = await prisma.messagePurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  if (now.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, alreadyPurchased: false, message: serializeMessage(m, viewer, true) };
  return { httpStatus: 202 as const, status: 'PENDING' as const, purchase: purchaseView(now), message: serializeMessage(m, viewer, false, { id: now.id, status: now.status === 'REVIEW' ? 'REVIEW' : 'PENDING' }) };
}

type PurchaseRow = { id: string; status: string; reviewReason: string | null; initiatedAt: Date; operator: string | null; grossFcfa: number };
const purchaseView = (p: PurchaseRow) => ({ id: p.id, status: p.status, operator: p.operator, priceFcfa: p.grossFcfa, initiatedAt: p.initiatedAt, review: p.status === 'REVIEW' });

/** État d'un achat pour son acheteur (sondé par l'application après un 202). Une fois PAID, renvoie le message déverrouillé. */
export async function getPurchase(viewer: User, purchaseId: string) {
  const p = await prisma.messagePurchase.findUnique({ where: { id: purchaseId }, include: { message: true } });
  if (!p || p.buyerId !== viewer.id) throw notFound('Achat introuvable');
  const [msg] = await serializeMessages([p.message], viewer);
  return { purchase: purchaseView(p), ...(p.status === 'PAID' ? { message: msg } : {}) };
}
