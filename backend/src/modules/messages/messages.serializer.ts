import type { Message, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { objectStorage } from '../../utils/objectStorage';
import { MESSAGE_IMAGE_MIME, mediaTypeOf } from './messages.schemas';

/**
 * Représentation d'un message pour `viewer`. RÈGLES :
 *  - le contenu d'un message payant n'est JAMAIS renvoyé au destinataire tant qu'un achat PAID n'existe pas ;
 *  - le contenu d'un message à vue unique n'est JAMAIS renvoyé ici, ni au destinataire (il passe par POST /open), ni à l'expéditeur
 *    (qui voit seulement qui a ouvert) ;
 *  - un message supprimé n'a plus de contenu pour personne.
 */
export type PendingPurchase = { id: string; status: 'PENDING' | 'REVIEW' };

/** Coches de l'expéditeur : SENT = envoyé ; DELIVERED = reçu par tous ; READ = lu par tous les membres qui ont les accusés activés. */
export type ReceiptStatus = 'SENT' | 'DELIVERED' | 'READ';
export type ReceiptMember = { lastReadAt: Date | null; lastDeliveredAt: Date | null; readReceipts: boolean };
export function receiptStatus(createdAt: Date, others: ReceiptMember[]): ReceiptStatus {
  if (others.length === 0) return 'SENT';
  const delivered = others.every((m) => (m.lastDeliveredAt && m.lastDeliveredAt >= createdAt) || (m.lastReadAt && m.lastReadAt >= createdAt));
  if (!delivered) return 'SENT';
  const readers = others.filter((m) => m.readReceipts);
  const read = readers.length > 0 && readers.every((m) => m.lastReadAt && m.lastReadAt >= createdAt);
  return read ? 'READ' : 'DELIVERED';
}

/** Destinataire d'un message à vue unique, tel que vu par le serveur. Ne contient aucun contenu. */
export type ViewOnceOpening = { userId: string; displayName: string | null; openedAt: Date | null };

/**
 * État de la vue unique pour `viewer` :
 *  - expéditeur : nombre de destinataires, nombre d'ouvertures et qui a ouvert (et quand) ;
 *  - destinataire : son propre état. `UNAVAILABLE` = il n'était pas membre à l'envoi, il ne peut pas l'ouvrir.
 */
export type ViewOnceView =
  | { role: 'SENDER'; total: number; openedCount: number; openings: ViewOnceOpening[] }
  | { role: 'RECIPIENT'; state: 'AVAILABLE' | 'OPENED' | 'UNAVAILABLE'; openedAt: Date | null };

function viewOnceView(m: Message, viewer: User, openings: ViewOnceOpening[]): ViewOnceView {
  if (m.senderId === viewer.id) {
    return { role: 'SENDER', total: openings.length, openedCount: openings.filter((o) => o.openedAt).length, openings };
  }
  const own = openings.find((o) => o.userId === viewer.id);
  if (!own) return { role: 'RECIPIENT', state: 'UNAVAILABLE', openedAt: null };
  return own.openedAt
    ? { role: 'RECIPIENT', state: 'OPENED', openedAt: own.openedAt }
    : { role: 'RECIPIENT', state: 'AVAILABLE', openedAt: null };
}

export function serializeMessage(m: Message, viewer: User, purchased: boolean, pending: PendingPurchase | null = null, openings: ViewOnceOpening[] = []) {
  const mine = m.senderId === viewer.id;
  const expired = !!m.expiresAt && m.expiresAt <= new Date();
  const deleted = !!m.deletedAt || expired;
  const priced = m.price != null;
  const locked = priced && !mine && !purchased && !deleted;
  const sealed = m.viewOnce && !deleted;
  const hide = deleted || locked || sealed;
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    mine,
    kind: locked || sealed ? null : m.kind,
    text: hide ? null : m.text,
    media: hide || !m.mediaKey ? null : {
      // URL TOUJOURS signée et de courte durée (jamais le CDN public) : une URL permanente contournerait le paiement et exposerait les conversations privées.
      url: objectStorage.privateReadUrl(m.mediaKey) || null,
      mimeType: m.mediaMime,
      type: mediaTypeOf(m.mediaMime),
      durationMs: m.mediaDurationMs ?? null,
      sizeBytes: m.mediaSize,
    },
    deleted,
    editedAt: m.editedAt,
    pinned: !!m.pinnedAt,
    replyToId: m.replyToId,
    forwarded: !!m.forwardedFromId,
    expiresAt: m.expiresAt,
    starred: false,
    status: null as ReceiptStatus | null,
    viewOnce: m.viewOnce && !deleted ? viewOnceView(m, viewer, openings) : null,
    // `payment` : paiement de l'acheteur en cours (PENDING) ou à vérifier (REVIEW) — l'écran reprend l'attente au lieu de reproposer l'achat.
    paid: priced && !deleted ? { price: m.price, currency: m.currency ?? 'XAF', locked, purchased, payment: locked && pending ? { purchaseId: pending.id, status: pending.status } : null } : null,
    createdAt: m.createdAt,
  };
}
export type MessageDto = ReturnType<typeof serializeMessage>;

/** Sérialise une page de messages avec un nombre fixe de requêtes (achats, réactions, destinataires de vue unique). */
export async function serializeMessages(rows: Message[], viewer: User): Promise<MessageDto[]> {
  const priced = rows.filter((r) => r.price != null).map((r) => r.id);
  const purchases = priced.length
    ? await prisma.messagePurchase.findMany({
        where: { messageId: { in: priced }, OR: [{ buyerId: viewer.id, status: { in: ['PAID', 'PENDING', 'REVIEW'] } }, { sellerId: viewer.id, status: 'PAID' }] },
        select: { id: true, messageId: true, status: true },
      })
    : [];
  const bought = new Set(purchases.filter((p) => p.status === 'PAID').map((p) => p.messageId));
  const pending = new Map<string, PendingPurchase>();
  for (const p of purchases) if (p.status === 'PENDING' || p.status === 'REVIEW') pending.set(p.messageId, { id: p.id, status: p.status });

  const viewOnceIds = rows.filter((r) => r.viewOnce).map((r) => r.id);
  const recipients = viewOnceIds.length
    ? await prisma.viewOnceRecipient.findMany({ where: { messageId: { in: viewOnceIds } }, select: { messageId: true, userId: true, openedAt: true, user: { select: { displayName: true } } } })
    : [];
  const openingsBy = new Map<string, ViewOnceOpening[]>();
  for (const r of recipients) {
    const list = openingsBy.get(r.messageId) ?? [];
    list.push({ userId: r.userId, displayName: r.user.displayName, openedAt: r.openedAt });
    openingsBy.set(r.messageId, list);
  }

  const reactionRows = rows.length ? await prisma.messageReaction.findMany({ where: { messageId: { in: rows.map((r) => r.id) } }, select: { messageId: true, userId: true, emoji: true } }) : [];
  const byMessage = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
  for (const r of reactionRows) {
    const arr = byMessage.get(r.messageId) ?? [];
    const x = arr.find((v) => v.emoji === r.emoji);
    if (x) { x.count++; x.mine ||= r.userId === viewer.id; } else arr.push({ emoji: r.emoji, count: 1, mine: r.userId === viewer.id });
    byMessage.set(r.messageId, arr);
  }
  const mineConvIds = [...new Set(rows.filter((r) => r.senderId === viewer.id && !r.deletedAt).map((r) => r.conversationId))];
  const others = mineConvIds.length
    ? await prisma.conversationMember.findMany({ where: { conversationId: { in: mineConvIds }, userId: { not: viewer.id } }, select: { conversationId: true, lastReadAt: true, lastDeliveredAt: true, user: { select: { showReadReceipts: true } } } })
    : [];
  const receiptsBy = new Map<string, ReceiptMember[]>();
  for (const o of others) {
    const list = receiptsBy.get(o.conversationId) ?? [];
    list.push({ lastReadAt: o.lastReadAt, lastDeliveredAt: o.lastDeliveredAt, readReceipts: o.user.showReadReceipts });
    receiptsBy.set(o.conversationId, list);
  }
  const starredRows = rows.length ? await prisma.starredMessage.findMany({ where: { userId: viewer.id, messageId: { in: rows.map((r) => r.id) } }, select: { messageId: true } }) : [];
  const starredIds = new Set(starredRows.map((s) => s.messageId));
  return rows.map((r) => ({
    ...serializeMessage(r, viewer, bought.has(r.id), pending.get(r.id) ?? null, openingsBy.get(r.id) ?? []),
    reactions: byMessage.get(r.id) ?? [],
    starred: starredIds.has(r.id),
    status: r.senderId === viewer.id && !r.deletedAt ? receiptStatus(r.createdAt, receiptsBy.get(r.conversationId) ?? []) : null,
  }));
}

/** Aperçu d'un message pour la liste des conversations (jamais le contenu d'un message payant verrouillé ni d'une vue unique). */
export function previewOf(m: Message | null, viewer: User, purchased: boolean): { text: string; mine: boolean; at: Date } | null {
  if (!m) return null;
  const mine = m.senderId === viewer.id;
  let text: string;
  if (m.deletedAt) text = 'Message supprimé';
  else if (m.viewOnce) text = '👁 Message à vue unique';
  else if (m.price != null && !mine && !purchased) text = '🔒 Message payant';
  else if (m.price != null && mine) text = m.mediaKey ? `💰 ${m.text?.trim() || 'Média'}` : `💰 ${m.text ?? ''}`;
  else if (m.mediaKey && !m.text) text = mediaTypeOf(m.mediaMime) === 'IMAGE' ? '📷 Photo' : mediaTypeOf(m.mediaMime) === 'AUDIO' ? '🎤 Vocal' : '🎬 Vidéo';
  else text = m.text ?? '';
  return { text: text.length > 120 ? `${text.slice(0, 117)}…` : text, mine, at: m.createdAt };
}
