import { Prisma, type Message, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { randomBytes } from 'node:crypto';
import { randomToken } from '../../utils/crypto';
import { decodeCursor, encodeCursor, readIdCursor, idCursor } from '../../utils/cursor';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { splitRecord } from '../../utils/money';
import { assertMobileMoneyCurrency, assertPriceInRange, DEFAULT_CURRENCY, limitIn, SUPPORTED_CURRENCIES } from '../../utils/currency';
import { objectStorage } from '../../utils/objectStorage';
import { payments, type MobileOperator } from '../../utils/payments';
import { blockedIdsFor } from '../content/access';
import { getConfigValue } from '../config/config.service';
import { markTargetRead, notify } from '../notifications/notifications.service';
import { toUserCards } from '../users/profile.service';
import { MESSAGE_AUDIO_MIME, MESSAGE_IMAGE_MIME, MESSAGE_VIDEO_MIME, mediaTypeOf } from './messages.schemas';
import { previewOf, serializeMessages } from './messages.serializer';
import { messagingPermission, pairKey } from './permission';
import { isUserOnline, publishRealtimeMany } from '../../realtime/realtime';

const dropObject = async (key: string | null | undefined) => { if (key) { try { await objectStorage.delete(key); } catch { /* nettoyage au mieux */ } } };
/** Supprime le fichier seulement s'il n'est plus référencé par aucun message : une copie transférée le partage avec l'original. */
const dropIfUnshared = async (key: string | null | undefined) => { if (!key) return; if ((await prisma.message.count({ where: { mediaKey: key, deletedAt: null } })) === 0) await dropObject(key); };
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Paramètres publics de la messagerie (le mobile ne doit rien coder en dur). */
export const settings = async () => ({
  maxChars: 2000,
  media: { enabled: env.MESSAGE_MEDIA_ENABLED, imageMaxBytes: env.MESSAGE_IMAGE_MAX_BYTES, videoMaxBytes: env.MESSAGE_VIDEO_MAX_BYTES, imageTypes: Object.keys(MESSAGE_IMAGE_MIME), videoTypes: Object.keys(MESSAGE_VIDEO_MIME) },
  /** `min`/`max` en FCFA (devise de référence) ; `byCurrency` donne les bornes en unités mineures de chaque devise acceptée. */
  paidMessages: {
    min: env.PAID_MESSAGE_MIN_FCFA, max: env.PAID_MESSAGE_MAX_FCFA, currency: DEFAULT_CURRENCY, currencies: SUPPORTED_CURRENCIES,
    byCurrency: Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c, { min: limitIn(env.PAID_MESSAGE_MIN_FCFA, c), max: limitIn(env.PAID_MESSAGE_MAX_FCFA, c) }])),
    commissionBps: env.PAID_MESSAGE_COMMISSION_BPS,
  },
  /** Opérateurs Mobile Money utilisables (liste vide = paiements non configurés : le mobile masque le bouton « Débloquer »). */
  payments: { enabled: payments.operators().length > 0, operators: payments.operators(), feePayer: env.PAYMENT_FEE_PAYER },
  /** Vue unique : `enabled` pilote l'envoi ; `paidAllowed` autorise la variante payante (même prix et commission que les messages payants). */
  viewOnce: { enabled: await viewOnceEnabled(), paidAllowed: await viewOncePaidAllowed() },
});

/** Drapeaux administrables (AppConfig). La valeur par défaut s'applique si la ligne est absente ou désactivée. */
export const viewOnceEnabled = async () => Boolean(await getConfigValue<boolean>('MESSAGING.VIEW_ONCE_ENABLED', true));
export const viewOncePaidAllowed = async () => Boolean(await getConfigValue<boolean>('MESSAGING.VIEW_ONCE_PAID_ALLOWED', true));

/**
 * Charge une conversation pour `viewer`. 404 si : inconnue, `viewer` n'en est pas membre, l'autre compte est inactif,
 * ou un blocage existe dans un sens ou l'autre (l'historique est conservé et réapparaît au déblocage).
 */
async function loadConversation(viewer: User, id: string) {
  const conv = await prisma.conversation.findUnique({ where: { id }, include: { members: { include: { user: true } } } });
  const me = conv?.members.find((m) => m.userId === viewer.id);
  if (!conv || !me) throw notFound('Conversation introuvable');
  // Groupe : être membre suffit. Pas d'interlocuteur unique, donc `other` vaut null (les contrôles de blocage ne s'appliquent qu'aux conversations directes).
  if (conv.isGroup) return { conv, me, other: null, isGroup: true as const };
  const other = conv.members.find((m) => m.userId !== viewer.id);
  if (!other || other.user.status !== 'ACTIVE') throw notFound('Conversation introuvable');
  const blocked = await prisma.block.findFirst({ where: { OR: [{ blockerId: viewer.id, blockedId: other.userId }, { blockerId: other.userId, blockedId: viewer.id }] }, select: { id: true } });
  if (blocked) throw notFound('Conversation introuvable');
  return { conv, me, other, isGroup: false as const };
}

/** Statut en ligne d'un interlocuteur, si son réglage le permet. `lastSeenAt` seulement quand il est hors ligne. */
const presenceOf = (u: User | null) => (u && u.showOnlineStatus ? { online: isUserOnline(u.id), lastSeenAt: isUserOnline(u.id) ? null : u.lastSeenAt } : null);

async function conversationDto(viewer: User, conv: { id: string; lastMessageAt: Date | null; lastMessageId: string | null; isGroup: boolean; name: string | null; photoKey: string | null; description: string | null; allowPaidContent: boolean; disappearingSeconds: number | null; members: unknown[] }, me: { unreadCount: number; role: 'ADMIN' | 'MEMBER' }, otherUser: User | null, withPermission: boolean) {
  const last = conv.lastMessageId ? await prisma.message.findFirst({ where: { id: conv.lastMessageId, hiddenFor: { none: { userId: viewer.id } }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }) : null;
  const purchased = last?.price != null ? !!(await prisma.messagePurchase.findFirst({ where: { messageId: last.id, status: 'PAID', OR: [{ buyerId: viewer.id }, { sellerId: viewer.id }] }, select: { id: true } })) : false;
  const lastMessage = previewOf(last, viewer, purchased);
  if (conv.isGroup || !otherUser) {
    return {
      id: conv.id, isGroup: true as const, name: conv.name, photoKey: conv.photoKey, description: conv.description, allowPaidContent: conv.allowPaidContent, disappearingSeconds: conv.disappearingSeconds ?? 0,
      memberCount: conv.members.length, myRole: me.role, other: null, unreadCount: me.unreadCount, lastMessageAt: conv.lastMessageAt, lastMessage,
      canSend: true, sendBlockedReason: null,
    };
  }
  const [card] = await toUserCards(viewer, [otherUser]);
  const perm = withPermission ? await messagingPermission(viewer, otherUser) : null;
  return {
    id: conv.id, isGroup: false as const, name: null, photoKey: null, description: null, allowPaidContent: true, disappearingSeconds: conv.disappearingSeconds ?? 0,
    memberCount: conv.members.length, myRole: me.role, other: card, presence: presenceOf(otherUser), unreadCount: me.unreadCount, lastMessageAt: conv.lastMessageAt, lastMessage,
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
  return { conversation: await conversationDto(viewer, conv, me, other?.user ?? null, true) };
}

/** Boîte de réception : conversations ayant au moins un message, non masquées, sans compte inactif ni blocage ; plus récentes d'abord. */
export async function listConversations(viewer: User, o: { cursor?: string; limit: number; archived?: string }) {
  const blocked = await blockedIdsFor(viewer.id);
  const c = decodeCursor(o.cursor);
  if (c && (typeof c.t !== 'number' || typeof c.i !== 'string')) throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
  const t = c ? new Date(c.t as number) : null;
  const where: Prisma.ConversationWhereInput = {
    lastMessageAt: { not: null },
    members: { some: { userId: viewer.id, hiddenAt: null, archivedAt: o.archived === '1' ? { not: null } : null } },
    NOT: { AND: [{ isGroup: false }, { members: { some: { userId: { not: viewer.id }, OR: [{ userId: { in: blocked } }, { user: { status: { not: 'ACTIVE' } } }] } } }] },
    ...(t ? { OR: [{ lastMessageAt: { lt: t } }, { lastMessageAt: t, id: { lt: String(c!.i) } }] } : {}),
  };
  const rows = await prisma.conversation.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: o.limit + 1, include: { members: { include: { user: true } } } });
  const page = rows.slice(0, o.limit);
  const lastIds = page.map((r) => r.lastMessageId).filter((x): x is string => !!x);
  const peers = page.filter((r) => !r.isGroup).map((r) => ({ id: r.id, user: r.members.find((m) => m.userId !== viewer.id)?.user ?? null }));
  const usable = peers.filter((p): p is { id: string; user: User } => p.user !== null);
  const [lasts, cards] = await Promise.all([
    prisma.message.findMany({ where: { id: { in: lastIds }, moderationStatus: 'ACTIVE', hiddenFor: { none: { userId: viewer.id } }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
    toUserCards(viewer, usable.map((p) => p.user)),
  ]);
  const paid = lasts.filter((m) => m.price != null).map((m) => m.id);
  const bought = new Set((paid.length ? await prisma.messagePurchase.findMany({ where: { messageId: { in: paid }, status: 'PAID', OR: [{ buyerId: viewer.id }, { sellerId: viewer.id }] }, select: { messageId: true } }) : []).map((p) => p.messageId));
  const byId = new Map(lasts.map((m) => [m.id, m]));
  const cardByConv = new Map(usable.map((p, i) => [p.id, cards[i]]));
  const items = page.map((r) => {
    const me = r.members.find((m) => m.userId === viewer.id)!;
    const last = r.lastMessageId ? byId.get(r.lastMessageId) ?? null : null;
    const base = { id: r.id, unreadCount: me.unreadCount, lastMessageAt: r.lastMessageAt, lastMessage: previewOf(last, viewer, last ? bought.has(last.id) : false) };
    if (r.isGroup) return { ...base, isGroup: true, name: r.name, photoKey: r.photoKey, memberCount: r.members.length, other: null };
    return { ...base, isGroup: false, name: null, photoKey: null, memberCount: r.members.length, other: cardByConv.get(r.id) ?? null };
  });
  const lastRow = page[page.length - 1];
  return { items, nextCursor: rows.length > o.limit && lastRow ? encodeCursor({ t: lastRow.lastMessageAt!.getTime(), i: lastRow.id }) : null };
}

/** Nombre de conversations contenant des messages non lus (pastille de l'icône Messages). */
export async function unreadConversations(viewer: User) {
  const blocked = await blockedIdsFor(viewer.id);
  return prisma.conversation.count({
    where: {
      members: { some: { userId: viewer.id, hiddenAt: null, archivedAt: null, unreadCount: { gt: 0 } } },
      NOT: { AND: [{ isGroup: false }, { members: { some: { userId: { not: viewer.id }, OR: [{ userId: { in: blocked } }, { user: { status: { not: 'ACTIVE' } } }] } } }] },
    },
  });
}

/** Messages d'une conversation, du plus récent au plus ancien ; ceux antérieurs à « supprimer la conversation » sont masqués. */
/** Le téléphone du membre a chargé la conversation : les messages reçus jusque-là sont « livrés » (coche grise). */
async function markDelivered(viewer: User, conversationId: string, lastMessageAt: Date | null, lastDeliveredAt: Date | null) {
  if (!lastMessageAt || (lastDeliveredAt && lastDeliveredAt >= lastMessageAt)) return;
  await prisma.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { lastDeliveredAt: new Date() } });
  const others = await prisma.conversationMember.findMany({ where: { conversationId, userId: { not: viewer.id } }, select: { userId: true } });
  publishRealtimeMany(others.map((o) => o.userId), { type: 'RECEIPT', payload: { conversationId } });
}

export async function listMessages(viewer: User, id: string, o: { cursor?: string; limit: number }) {
  const { conv, me } = await loadConversation(viewer, id);
  await markDelivered(viewer, id, conv.lastMessageAt, me.lastDeliveredAt);
  const cursorId = readIdCursor(o.cursor);
  const rows = await prisma.message.findMany({
    where: { conversationId: id, moderationStatus: 'ACTIVE', hiddenFor: { none: { userId: viewer.id } }, ...(me.clearedAt ? { createdAt: { gt: me.clearedAt } } : {}), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
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
  if (other) {
    const perm = await messagingPermission(viewer, other.user);
    if (!perm.allowed) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
  }
  const isImage = !!MESSAGE_IMAGE_MIME[b.contentType];
  const isAudio = !!MESSAGE_AUDIO_MIME[b.contentType];
  const ext = MESSAGE_IMAGE_MIME[b.contentType] ?? MESSAGE_VIDEO_MIME[b.contentType] ?? MESSAGE_AUDIO_MIME[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', 'Format non pris en charge (images JPEG, PNG, WebP ; vidéos MP4, MOV, WebM ; vocaux M4A, AAC, MP3)');
  const max = isImage ? env.MESSAGE_IMAGE_MAX_BYTES : isAudio ? env.MESSAGE_AUDIO_MAX_BYTES : env.MESSAGE_VIDEO_MAX_BYTES;
  if (b.sizeBytes > max) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(max / 1_048_576)} Mo maximum)`);
  const key = `messages/${b.conversationId}/${viewer.id}/${randomToken(9)}.${ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

type SendInput = { text?: string; mediaKey?: string; price?: number; currency?: string; clientId?: string; viewOnce?: boolean; durationMs?: number };

export async function sendMessage(viewer: User, conversationId: string, b: SendInput) {
  if (b.clientId) {
    const dup = await prisma.message.findUnique({ where: { senderId_clientId: { senderId: viewer.id, clientId: b.clientId } } });
    if (dup) return { created: false, message: (await serializeMessages([dup], viewer))[0] };
  }
  const { conv, me, other } = await loadConversation(viewer, conversationId);
  if (other) {
    const perm = await messagingPermission(viewer, other.user);
    if (!perm.allowed) {
      const canReply = perm.reason === 'NOT_ALLOWED' && !!(await prisma.message.findFirst({ where:{conversationId, senderId:other.user.id}, select:{id:true} }));
      if (!canReply) throw forbidden('MESSAGES_NOT_ALLOWED', "Cet utilisateur n'accepte pas de messages de votre part");
    }
  }

  if (b.viewOnce) {
    if (!(await viewOnceEnabled())) throw forbidden('VIEW_ONCE_DISABLED', 'Les messages à vue unique sont désactivés');
    if (!b.mediaKey) throw badRequest('VIEW_ONCE_MEDIA_ONLY', 'Le mode vue unique ne concerne que les photos et vidéos');
    if (b.text) throw badRequest('VIEW_ONCE_NO_TEXT', 'Un message à vue unique ne peut pas contenir de texte');
    if (b.price != null && !(await viewOncePaidAllowed())) throw forbidden('VIEW_ONCE_PAID_DISABLED', 'Les photos et vidéos à vue unique payantes sont désactivées');
  }

  if (b.price != null) {
    if (!viewer.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur pour envoyer des messages payants');
    if (conv.isGroup && !conv.allowPaidContent) throw forbidden('GROUP_PAID_CONTENT_DISABLED', 'Les messages payants sont désactivés dans ce groupe');
    assertPriceInRange(b.price, b.currency ?? DEFAULT_CURRENCY, env.PAID_MESSAGE_MIN_FCFA, env.PAID_MESSAGE_MAX_FCFA);
  }

  let media: { key: string; mime: string; size: number } | null = null;
  if (b.mediaKey) {
    if (!env.MESSAGE_MEDIA_ENABLED) throw forbidden('MEDIA_DISABLED', "L'envoi de médias est désactivé");
    // La clé doit avoir été émise par le serveur pour CET expéditeur et CETTE conversation, et n'être utilisée qu'une fois.
    if (!b.mediaKey.startsWith(`messages/${conversationId}/${viewer.id}/`)) throw badRequest('INVALID_MEDIA', 'Média invalide');
    const ext = b.mediaKey.split('.').pop() ?? '';
    const mime = Object.entries({ ...MESSAGE_IMAGE_MIME, ...MESSAGE_VIDEO_MIME, ...MESSAGE_AUDIO_MIME }).find(([, e]) => e === ext)?.[0];
    if (!mime) throw badRequest('INVALID_MEDIA', 'Média invalide');
    if (await prisma.message.findFirst({ where: { mediaKey: b.mediaKey }, select: { id: true } })) throw conflict('MEDIA_ALREADY_USED', 'Ce média a déjà été envoyé');
    const info = await objectStorage.head(b.mediaKey);
    if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
    const max = MESSAGE_IMAGE_MIME[mime] ? env.MESSAGE_IMAGE_MAX_BYTES : MESSAGE_AUDIO_MIME[mime] ? env.MESSAGE_AUDIO_MAX_BYTES : env.MESSAGE_VIDEO_MAX_BYTES;
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
          mediaKey: media?.key ?? null, mediaMime: media?.mime ?? null, mediaSize: media?.size ?? null, mediaDurationMs: media ? b.durationMs ?? null : null,
          price: b.price ?? null, currency: b.price != null ? (b.currency ?? DEFAULT_CURRENCY) : null, clientId: b.clientId ?? null, viewOnce: b.viewOnce === true, replyToId: null, createdAt: now, expiresAt: !b.viewOnce && conv.disappearingSeconds ? new Date(now.getTime() + conv.disappearingSeconds * 1000) : null,
        },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: m.createdAt, lastMessageId: m.id } });
      await tx.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { hiddenAt: null, lastReadAt: now, unreadCount: 0 } });
      const recipients = conv.members.filter((x) => x.userId !== viewer.id).map((x) => x.userId);
      await tx.conversationMember.updateMany({ where: { conversationId, userId: { in: recipients } }, data: { hiddenAt: null, archivedAt: null, unreadCount: { increment: 1 } } });
      // Destinataires connectés : le message leur est arrivé (coche grise tout de suite).
      await tx.conversationMember.updateMany({ where: { conversationId, userId: { in: recipients.filter((id) => isUserOnline(id)) } }, data: { lastDeliveredAt: now } });
      if (b.viewOnce) await tx.viewOnceRecipient.createMany({ data: recipients.map((userId) => ({ messageId: m.id, userId })) });
      for (const userId of recipients) await notify(tx, { userId, type: 'NEW_MESSAGE', actorId: viewer.id, targetType: 'CONVERSATION', targetId: conversationId });
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
  const { conv } = await loadConversation(viewer, conversationId);
  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { unreadCount: 0, lastReadAt: new Date() } });
    await markTargetRead(tx, viewer.id, 'NEW_MESSAGE', conversationId);
  });
  // Les autres membres voient les coches passer en bleu sans attendre un rechargement.
  publishRealtimeMany(conv.members.filter((m) => m.userId !== viewer.id).map((m) => m.userId), { type: 'RECEIPT', payload: { conversationId } });
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
  if (m.price != null && (await prisma.messagePurchase.findFirst({ where: { messageId: id, status: { in: ['PAID', 'PENDING', 'REVIEW'] } }, select: { id: true } }))) {
    throw conflict('MESSAGE_PURCHASED', 'Ce message payant a été acheté (ou un paiement est en cours) : il ne peut plus être supprimé');
  }
  await prisma.$transaction(async (tx) => {
    await tx.message.update({ where: { id }, data: { deletedAt: new Date(), text: null, mediaKey: null, mediaMime: null, mediaSize: null } });
    const recs = m.conversation.members.filter((x) => x.userId !== viewer.id && x.unreadCount > 0 && (!x.lastReadAt || m.createdAt > x.lastReadAt));
    for (const rec of recs) await tx.conversationMember.update({ where: { id: rec.id }, data: { unreadCount: { decrement: 1 } } });
  });
  await dropIfUnshared(m.mediaKey);
}

/** Retire de la base tout le contenu envoyé par un compte qui se supprime (les achats sont conservés : traçabilité financière). */
export async function purgeSentMessages(userId: string) {
  const rows = await prisma.message.findMany({ where: { senderId: userId, deletedAt: null, mediaKey: { not: null } }, select: { mediaKey: true } });
  await prisma.message.updateMany({ where: { senderId: userId, deletedAt: null }, data: { deletedAt: new Date(), text: null, mediaKey: null, mediaMime: null, mediaSize: null } });
  await Promise.all(rows.map((r) => dropIfUnshared(r.mediaKey)));
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
  if (m.deletedAt || m.price == null) throw notFound('Message introuvable');
  if (m.senderId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Vous ne pouvez pas acheter votre propre message');
  if (other && other.userId !== m.senderId) throw notFound('Message introuvable');
  if (!payments.operators().includes(input.operator)) {
    if (payments.operators().length === 0) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible", { operator: 'Opérateur indisponible' });
  }

  const existing = await prisma.messagePurchase.findUnique({ where: { messageId_buyerId: { messageId, buyerId: viewer.id } } });
  if (existing?.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, alreadyPurchased: true, message: (await serializeMessages([m], viewer))[0] };
  if (existing?.status === 'PENDING') throw conflict('PAYMENT_IN_PROGRESS', 'Un paiement est déjà en cours pour ce message', { purchaseId: existing.id });
  if (existing?.status === 'REVIEW') throw conflict('PAYMENT_UNDER_REVIEW', 'Votre paiement est en cours de vérification : ne le renouvelez pas, vous serez notifié', { purchaseId: existing.id });

  const currency = m.currency ?? DEFAULT_CURRENCY;
  assertMobileMoneyCurrency(currency);
  const split = splitRecord(m.price, env.PAID_MESSAGE_COMMISSION_BPS, currency);
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
    res = await payments.initiate({ reference, amount: split.grossAmount, currency, operator: input.operator, phone: input.phone, description: 'Message payant' });
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
  if (now.status === 'PAID') return { httpStatus: 200 as const, status: 'PAID' as const, alreadyPurchased: false, message: (await serializeMessages([m], viewer))[0] };
  return { httpStatus: 202 as const, status: 'PENDING' as const, purchase: purchaseView(now), message: (await serializeMessages([m], viewer))[0] };
}

type PurchaseRow = { id: string; status: string; reviewReason: string | null; initiatedAt: Date; operator: string | null; grossAmount: number; currency: string };
const purchaseView = (p: PurchaseRow) => ({ id: p.id, status: p.status, operator: p.operator, price: p.grossAmount, currency: p.currency, initiatedAt: p.initiatedAt, review: p.status === 'REVIEW' });

/** État d'un achat pour son acheteur (sondé par l'application après un 202). Une fois PAID, renvoie le message déverrouillé. */
export async function getPurchase(viewer: User, purchaseId: string) {
  const p = await prisma.messagePurchase.findUnique({ where: { id: purchaseId }, include: { message: true } });
  if (!p || p.buyerId !== viewer.id) throw notFound('Achat introuvable');
  const [msg] = await serializeMessages([p.message], viewer);
  return { purchase: purchaseView(p), ...(p.status === 'PAID' ? { message: msg } : {}) };
}

/**
 * Ouverture d'une photo ou vidéo à vue unique, par un destinataire, UNE SEULE FOIS. C'est la seule réponse qui contient le média.
 * Chaque destinataire a sa propre ligne (ViewOnceRecipient) : l'ouverture de l'un ne consomme pas le message des autres.
 * La première ouverture de SA ligne gagne (écriture conditionnelle sur `openedAt IS NULL`) : deux requêtes simultanées ne servent
 * jamais le média deux fois. Une vue payante exige un achat PAID préalable.
 */
export async function openViewOnce(viewer: User, messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId } });
  if (!m || !m.viewOnce || m.deletedAt || m.moderationStatus !== 'ACTIVE' || !m.mediaKey) throw notFound('Message introuvable');
  await loadConversation(viewer, m.conversationId); // 404 si non membre, bloqué ou inactif
  if (m.senderId === viewer.id) throw forbidden('VIEW_ONCE_SENDER', 'Vous ne pouvez pas ouvrir votre propre message à vue unique');
  const row = await prisma.viewOnceRecipient.findUnique({ where: { messageId_userId: { messageId, userId: viewer.id } } });
  if (!row) throw notFound('Message introuvable'); // pas destinataire : membre arrivé après l'envoi, ou retiré du groupe avant l'ouverture
  if (row.openedAt) throw new AppError(410, 'VIEW_ONCE_CONSUMED', 'Ce message a déjà été ouvert');
  if (m.price != null && !(await prisma.messagePurchase.findFirst({ where: { messageId, buyerId: viewer.id, status: 'PAID' }, select: { id: true } }))) {
    throw forbidden('MESSAGE_LOCKED', 'Déverrouillez le message avant de l’ouvrir');
  }
  const now = new Date();
  const claimed = await prisma.viewOnceRecipient.updateMany({ where: { messageId, userId: viewer.id, openedAt: null }, data: { openedAt: now } });
  if (claimed.count !== 1) throw new AppError(410, 'VIEW_ONCE_CONSUMED', 'Ce message a déjà été ouvert');
  return {
    message: {
      id: m.id, conversationId: m.conversationId, senderId: m.senderId, mine: false, kind: 'MEDIA' as const, text: null,
      media: { url: objectStorage.privateReadUrl(m.mediaKey, env.VIEW_ONCE_URL_TTL_SECONDS), mimeType: m.mediaMime, type: mediaTypeOf(m.mediaMime), durationMs: m.mediaDurationMs ?? null, sizeBytes: m.mediaSize },
      viewOnce: { role: 'RECIPIENT' as const, state: 'OPENED' as const, openedAt: now },
      createdAt: m.createdAt,
    },
  };
}

export async function reactToMessage(viewer: User, messageId: string, emoji: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId } });
  if (!m) throw notFound('Message introuvable');
  await loadConversation(viewer, m.conversationId);
  const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId, userId: viewer.id } } });
  if (existing?.emoji === emoji) await prisma.messageReaction.delete({ where: { id: existing.id } });
  else if (existing) await prisma.messageReaction.update({ where: { id: existing.id }, data: { emoji } });
  else await prisma.messageReaction.create({ data: { messageId, userId: viewer.id, emoji } });
  return { reactions: await prisma.messageReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } }) };
}

export async function editMessage(viewer: User, messageId: string, text: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId } });
  if (!m || m.senderId !== viewer.id || m.deletedAt) throw notFound('Message introuvable');
  if (m.price != null) throw conflict('PAID_MESSAGE_IMMUTABLE', 'Un message payant ne peut pas être modifié');
  if (m.viewOnce) throw conflict('VIEW_ONCE_IMMUTABLE', 'Un message à vue unique ne peut pas être modifié');
  if (Date.now() - m.createdAt.getTime() > 15 * 60 * 1000) throw conflict('EDIT_WINDOW_EXPIRED', 'Le délai de modification est dépassé');
  const updated = await prisma.message.update({ where: { id: messageId }, data: { text, editedAt: new Date() } });
  return (await serializeMessages([updated], viewer))[0];
}

export async function pinMessage(viewer: User, messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId } });
  if (!m) throw notFound('Message introuvable');
  await loadConversation(viewer, m.conversationId);
  const pinned = !m.pinnedAt;
  await prisma.message.update({ where: { id: messageId }, data: { pinnedAt: pinned ? new Date() : null } });
  return { pinned };
}

export async function replyMessage(viewer: User, conversationId: string, messageId: string, b: SendInput) {
  const source = await prisma.message.findUnique({ where: { id: messageId } });
  if (!source || source.conversationId !== conversationId) throw notFound('Message introuvable');
  const result = await sendMessage(viewer, conversationId, b);
  if (result.message?.id) await prisma.message.update({ where: { id: result.message.id }, data: { replyToId: messageId } });
  return result;
}

export async function forwardMessage(viewer: User, messageId: string, targetConversationId: string) {
  const source = await prisma.message.findUnique({ where: { id: messageId } });
  if (!source || source.deletedAt) throw notFound('Message introuvable');
  if (source.viewOnce) throw forbidden('VIEW_ONCE_NOT_FORWARDABLE', 'Un message à vue unique ne peut pas être transféré');
  await loadConversation(viewer, source.conversationId);
  const target = await loadConversation(viewer, targetConversationId);
  const paidLocked = source.price != null && source.senderId !== viewer.id && !(await prisma.messagePurchase.findFirst({ where: { messageId, buyerId: viewer.id, status: 'PAID' }, select: { id: true } }));
  if (paidLocked) throw forbidden('MESSAGE_LOCKED', 'Déverrouillez le message avant de le transférer');
  const created = await prisma.message.create({ data: { conversationId: targetConversationId, senderId: viewer.id, kind: source.kind, text: source.text, mediaKey: source.mediaKey, mediaMime: source.mediaMime, mediaSize: source.mediaSize, mediaDurationMs: source.mediaDurationMs, forwardedFromId: source.id, expiresAt: target.conv.disappearingSeconds ? new Date(Date.now() + target.conv.disappearingSeconds * 1000) : null } });
  await prisma.conversation.update({ where: { id: target.conv.id }, data: { lastMessageAt: created.createdAt, lastMessageId: created.id } });
  await prisma.conversationMember.updateMany({ where: { conversationId: targetConversationId, userId: viewer.id }, data: { hiddenAt: null, lastReadAt: new Date(), unreadCount: 0 } });
  await prisma.conversationMember.updateMany({ where: { conversationId: targetConversationId, userId: { not: viewer.id } }, data: { unreadCount: { increment: 1 } } });
  return (await serializeMessages([created], viewer))[0];
}

export async function searchMessages(viewer: User, conversationId: string, q: string, o: { cursor?: string; limit: number }) {
  const { me } = await loadConversation(viewer, conversationId);
  const cursorId = readIdCursor(o.cursor);
  const rows = await prisma.message.findMany({ where: { conversationId, moderationStatus: 'ACTIVE', deletedAt: null, ...(me.clearedAt ? { createdAt: { gt: me.clearedAt } } : {}), text: { contains: q, mode: 'insensitive' }, viewOnce: false, hiddenFor: { none: { userId: viewer.id } }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: o.limit + 1, ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}) });
  const page = rows.slice(0, o.limit);
  return { items: await serializeMessages(page, viewer), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}

export async function setMute(viewer: User, conversationId: string, seconds: number) {
  const { me } = await loadConversation(viewer, conversationId);
  await prisma.conversationMember.update({ where: { id: me.id }, data: { mutedUntil: seconds ? new Date(Date.now() + seconds * 1000) : null } });
  return { mutedUntil: seconds ? new Date(Date.now() + seconds * 1000) : null };
}

/** Messages éphémères de la conversation (0 = désactivé). Dans un groupe, réservé aux administrateurs. Ne touche pas aux messages déjà envoyés. */
export async function setDisappearing(viewer: User, conversationId: string, seconds: number) {
  const { conv, me } = await loadConversation(viewer, conversationId);
  if (conv.isGroup && me.role !== 'ADMIN') throw forbidden('GROUP_ADMIN_REQUIRED', 'Seuls les administrateurs peuvent régler les messages éphémères du groupe');
  const value = seconds || null;
  await prisma.conversation.update({ where: { id: conv.id }, data: { disappearingSeconds: value } });
  return { seconds: value ?? 0 };
}

export async function setChatLock(viewer: User, conversationId: string, locked: boolean) {
  const { me } = await loadConversation(viewer, conversationId);
  await prisma.conversationMember.update({ where: { id: me.id }, data: { lockedAt: locked ? new Date() : null } });
  return { locked };
}

export async function exportConversation(viewer: User, conversationId: string) {
  const { me } = await loadConversation(viewer, conversationId);
  const rows = await prisma.message.findMany({ where: { conversationId, deletedAt: null, hiddenFor: { none: { userId: viewer.id } }, ...(me.clearedAt ? { createdAt: { gt: me.clearedAt } } : {}), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, senderId: true, text: true, kind: true, createdAt: true, editedAt: true, forwardedFromId: true, viewOnce: true } });
  // Vue unique : jamais de contenu dans un export (la vue unique ne doit pas survivre hors de l'application).
  return { conversationId, exportedAt: new Date().toISOString(), messages: rows.map((r) => (r.viewOnce ? { ...r, text: null } : r)) };
}

/** Archiver : la conversation sort de la boîte principale et reste dans « Archivées ». Un nouveau message la ramène. */
export async function setArchived(viewer: User, conversationId: string, archived: boolean) {
  await loadConversation(viewer, conversationId);
  await prisma.conversationMember.updateMany({ where: { conversationId, userId: viewer.id }, data: { archivedAt: archived ? new Date() : null } });
  return { archived };
}

/** « Supprimer pour moi » : le message disparaît seulement de MA vue. Les autres membres le gardent. */
export async function hideForMe(viewer: User, messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (!m) throw notFound('Message introuvable');
  await loadConversation(viewer, m.conversationId);
  await prisma.hiddenMessage.upsert({ where: { messageId_userId: { messageId, userId: viewer.id } }, create: { messageId, userId: viewer.id }, update: {} });
}

/** Favori (étoile) : seulement sur un message auquel on a accès. */
export async function setStarred(viewer: User, messageId: string, starred: boolean) {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, deletedAt: true } });
  if (!m || m.deletedAt) throw notFound('Message introuvable');
  await loadConversation(viewer, m.conversationId);
  if (starred) await prisma.starredMessage.upsert({ where: { messageId_userId: { messageId, userId: viewer.id } }, create: { messageId, userId: viewer.id }, update: {} });
  else await prisma.starredMessage.deleteMany({ where: { messageId, userId: viewer.id } });
  return { starred };
}

/** Messages favoris, du plus récent au plus ancien. Exclut les messages supprimés pour moi, les conversations quittées et celles avec un compte bloqué. */
export async function listStarred(viewer: User, o: { conversationId?: string; limit: number }) {
  const blocked = await blockedIdsFor(viewer.id);
  const rows = await prisma.starredMessage.findMany({
    where: {
      userId: viewer.id,
      message: {
        deletedAt: null, moderationStatus: 'ACTIVE', hiddenFor: { none: { userId: viewer.id } },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(o.conversationId ? { conversationId: o.conversationId } : {}),
        conversation: { members: { some: { userId: viewer.id } }, OR: [{ isGroup: true }, { NOT: { members: { some: { userId: { in: blocked } } } } }] },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: o.limit,
    include: { message: true },
  });
  return { items: await serializeMessages(rows.map((r) => r.message), viewer) };
}
