import type { Prisma, PrismaClient, User } from '@prisma/client';
import { env } from '../../config/env';

export type Kind = 'VIDEO' | 'SHORT';
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Ligne `Video` ou `Short` (les deux tables ont exactement les mêmes colonnes). */
export type ContentRow = {
  id: string; authorId: string; title: string; description: string | null; category: string;
  visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; status: 'DRAFT' | 'PUBLISHED' | 'HIDDEN' | 'REMOVED';
  allowDownload: boolean; subscriptionOnly: boolean; allowComments: boolean;
  videoKey: string | null; thumbnailKey: string | null; mimeType: string | null; sizeBytes: number | null;
  durationSeconds: number | null; width: number | null; height: number | null;
  uploadedAt: Date | null; publishedAt: Date | null;
  viewCount: number; likeCount: number; commentCount: number; shareCount: number;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null;
  processingStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'; processingError: string | null; processedAt: Date | null; manifestKey: string | null;
};
export type PublicAuthor = Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'bio' | 'country' | 'links' | 'isCreator' | 'profileVisibility' | 'createdAt'>;
export type ContentWithAuthor = ContentRow & { author: User };
export type ContentWithPublicAuthor = ContentRow & { author: PublicAuthor };

/** Sous-ensemble des méthodes Prisma utilisées, commun aux deux délégués (évite une union de délégués non appelable). */
export type Repo = {
  findUnique(args: unknown): Promise<any>;
  findMany(args: unknown): Promise<any[]>;
  create(args: unknown): Promise<any>;
  update(args: unknown): Promise<any>;
  updateMany(args: unknown): Promise<{ count: number }>;
};
export const repo = (db: DbClient, kind: Kind): Repo => (kind === 'VIDEO' ? db.video : db.short) as unknown as Repo;

export const KINDS: Record<Kind, { route: 'videos' | 'shorts'; keyPrefix: string; label: string; maxBytes: () => number }> = {
  VIDEO: { route: 'videos', keyPrefix: 'videos', label: 'Vidéo', maxBytes: () => env.VIDEO_MAX_BYTES },
  SHORT: { route: 'shorts', keyPrefix: 'shorts', label: 'Short', maxBytes: () => env.SHORT_MAX_BYTES },
};

export const VIDEO_MIME: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
export const IMAGE_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
