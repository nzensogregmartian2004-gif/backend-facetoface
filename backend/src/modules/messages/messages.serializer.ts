import type { Message, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { objectStorage } from '../../utils/objectStorage';
import { MESSAGE_IMAGE_MIME } from './messages.schemas';

/**
 * Représentation d'un message pour `viewer`. RÈGLE : le contenu d'un message payant n'est JAMAIS renvoyé au destinataire
 * tant qu'un achat PAID n'existe pas (ni texte, ni URL de média, ni type de média). L'expéditeur voit toujours le sien.
 * Un message supprimé n'a plus de contenu pour personne.
 */
export type PendingPurchase = { id: string; status: 'PENDING' | 'REVIEW' };

export function serializeMessage(m: Message, viewer: User, purchased: boolean, pending: PendingPurchase | null = null) {
  const mine = m.senderId === viewer.id;
  const deleted = !!m.deletedAt;
  const priced = m.priceFcfa != null;
  const locked = priced && !mine && !purchased && !deleted;
  const hide = deleted || locked;
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    mine,
    kind: locked ? null : m.kind,
    text: hide ? null : m.text,
    media: hide || !m.mediaKey ? null : {
      // URL TOUJOURS signée et de courte durée (jamais le CDN public) : une URL permanente contournerait le paiement et exposerait les conversations privées.
      url: objectStorage.privateReadUrl(m.mediaKey) || null,
      mimeType: m.mediaMime,
      type: m.mediaMime && MESSAGE_IMAGE_MIME[m.mediaMime] ? 'IMAGE' : 'VIDEO',
      sizeBytes: m.mediaSize,
    },
    deleted,
    // `payment` : paiement de l'acheteur en cours (PENDING) ou à vérifier (REVIEW) — l'écran reprend l'attente au lieu de reproposer l'achat.
    paid: priced && !deleted ? { priceFcfa: m.priceFcfa, locked, purchased, payment: locked && pending ? { purchaseId: pending.id, status: pending.status } : null } : null,
    createdAt: m.createdAt,
  };
}
export type MessageDto = ReturnType<typeof serializeMessage>;

/** Sérialise une page de messages avec une seule requête sur les achats (ceux du spectateur, ou ceux de ses propres messages vendus). */
export async function serializeMessages(rows: Message[], viewer: User): Promise<MessageDto[]> {
  const priced = rows.filter((r) => r.priceFcfa != null).map((r) => r.id);
  const purchases = priced.length
    ? await prisma.messagePurchase.findMany({
        where: { messageId: { in: priced }, OR: [{ buyerId: viewer.id, status: { in: ['PAID', 'PENDING', 'REVIEW'] } }, { sellerId: viewer.id, status: 'PAID' }] },
        select: { id: true, messageId: true, status: true },
      })
    : [];
  const bought = new Set(purchases.filter((p) => p.status === 'PAID').map((p) => p.messageId));
  const pending = new Map<string, PendingPurchase>();
  for (const p of purchases) if (p.status === 'PENDING' || p.status === 'REVIEW') pending.set(p.messageId, { id: p.id, status: p.status });
  return rows.map((r) => serializeMessage(r, viewer, bought.has(r.id), pending.get(r.id) ?? null));
}

/** Aperçu d'un message pour la liste des conversations (jamais le contenu d'un message payant verrouillé). */
export function previewOf(m: Message | null, viewer: User, purchased: boolean): { text: string; mine: boolean; at: Date } | null {
  if (!m) return null;
  const mine = m.senderId === viewer.id;
  let text: string;
  if (m.deletedAt) text = 'Message supprimé';
  else if (m.priceFcfa != null && !mine && !purchased) text = '🔒 Message payant';
  else if (m.priceFcfa != null && mine) text = m.mediaKey ? `💰 ${m.text?.trim() || 'Média'}` : `💰 ${m.text ?? ''}`;
  else if (m.mediaKey && !m.text) text = m.mediaMime && MESSAGE_IMAGE_MIME[m.mediaMime] ? '📷 Photo' : '🎬 Vidéo';
  else text = m.text ?? '';
  return { text: text.length > 120 ? `${text.slice(0, 117)}…` : text, mine, at: m.createdAt };
}
