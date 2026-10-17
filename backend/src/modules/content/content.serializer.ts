import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../config/db';
import { objectStorage } from '../../utils/objectStorage';
import { serializePublic } from '../../utils/serializers';
import { KINDS, type ContentWithPublicAuthor, type Kind } from './types';
import { downloadsEnabledNow } from './downloads.setting';

export const shareUrl = (kind: Kind, id: string) => `${(env.SHARE_BASE_URL ?? env.PUBLIC_BASE_URL).replace(/\/$/, '')}/${KINDS[kind].route}/${id}`;

/** Projection minimale utilisée par les listes/feed : jamais de hash de mot de passe ni de champs privés inutiles. */
export const PUBLIC_AUTHOR_SELECT = {
  id: true, username: true, displayName: true, avatarUrl: true, bio: true, country: true, links: true,
  isCreator: true, profileVisibility: true, createdAt: true,
} as const;

/** URL de la miniature (ou null). Le fichier vidéo, lui, n'est jamais exposé ici : voir GET /:id/playback. */
const thumbUrl = (key: string | null) => (key ? objectStorage.readUrl(key) || null : null);

/** Représentation d'un contenu. L'auteur passe par `serializePublic` (seul point de sortie d'un utilisateur). */
/** Ce que le spectateur a déjà fait sur ce contenu et avec son auteur. Les champs optionnels valent false par défaut. */
export type ViewerFlags = { liked: boolean; followsAuthor: boolean; purchased: boolean; disliked?: boolean; saved?: boolean; notifyOn?: boolean };

export function serializeContent(kind: Kind, row: ContentWithPublicAuthor, viewer: User, flags: ViewerFlags) {
  const isOwner = row.authorId === viewer.id;
  return {
    id: row.id,
    kind,
    title: row.title,
    description: row.description,
    category: row.category,
    paid: row.price != null ? { enabled: true, price: row.price, currency: row.currency!, purchased: isOwner || flags.purchased } : null,
    visibility: row.visibility,
    status: row.status,
    subscriptionOnly: row.subscriptionOnly,
    allowDownload: isOwner ? row.allowDownload : row.allowDownload && downloadsEnabledNow(), // le propriétaire voit son réglage ; les autres, le réglage effectif
    allowComments: row.allowComments,
    thumbnailUrl: thumbUrl(row.thumbnailKey),
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    uploaded: !!row.uploadedAt,
    processingStatus: row.processingStatus,
    counts: { views: row.viewCount, likes: row.likeCount, comments: row.commentCount, shares: row.shareCount },
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    author: serializePublic(row.author),
    viewer: { liked: flags.liked, disliked: flags.disliked ?? false, saved: flags.saved ?? false, followsAuthor: flags.followsAuthor, notifyOn: flags.notifyOn ?? false, isOwner },
  };
}
export type ContentDto = ReturnType<typeof serializeContent>;

/** Sérialise une page de contenus avec deux requêtes groupées (likes du spectateur, abonnements aux auteurs). */
export async function serializeMany(kind: Kind, rows: ContentWithPublicAuthor[], viewer: User): Promise<ContentDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const [likes, dislikes, saves, follows, purchases] = await Promise.all([
    prisma.like.findMany({ where: { userId: viewer.id, targetType: kind, targetId: { in: ids } }, select: { targetId: true } }),
    prisma.dislike.findMany({ where: { userId: viewer.id, targetType: kind, targetId: { in: ids } }, select: { targetId: true } }),
    prisma.savedContent.findMany({ where: { userId: viewer.id, targetType: kind, targetId: { in: ids } }, select: { targetId: true } }),
    prisma.follow.findMany({ where: { followerId: viewer.id, followingId: { in: authorIds } }, select: { followingId: true, notifyOn: true } }),
    prisma.paidContentPurchase.findMany({ where: { buyerId: viewer.id, contentType: kind, contentId: { in: ids }, status: 'PAID' }, select: { contentId: true } }),
  ]);
  const liked = new Set(likes.map((l) => l.targetId));
  const followed = new Set(follows.map((f) => f.followingId));
  const disliked = new Set(dislikes.map((d) => d.targetId));
  const saved = new Set(saves.map((s) => s.targetId));
  const notified = new Set(follows.filter((f) => f.notifyOn).map((f) => f.followingId));
  const purchased = new Set(purchases.map((p) => p.contentId));
  return rows.map((r) => serializeContent(kind, r, viewer, { liked: liked.has(r.id), disliked: disliked.has(r.id), saved: saved.has(r.id), followsAuthor: followed.has(r.authorId), notifyOn: notified.has(r.authorId), purchased: purchased.has(r.id) }));
}

export const serializeOne = async (kind: Kind, row: ContentWithPublicAuthor, viewer: User) => (await serializeMany(kind, [row], viewer))[0];
