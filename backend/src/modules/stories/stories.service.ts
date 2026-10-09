import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { objectStorage } from '../../utils/objectStorage';
import { randomToken } from '../../utils/crypto';
import { getConfigValue } from '../config/config.service';
import { blockedIdsFor } from '../content/access';
import { contentLocked } from '../users/profile.access';
import { MESSAGE_IMAGE_MIME, MESSAGE_VIDEO_MIME, mediaTypeOf } from '../messages/messages.schemas';

const HOUR_MS = 3_600_000;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const dropObject = async (key: string | null | undefined) => { if (key) { try { await objectStorage.delete(key); } catch (e) { console.error('[stories] suppression du fichier impossible', e); } } };

/** Durée de vie valide : nombre entier d'heures, entre 1 et le maximum administrable. */
export const isValidStoryHours = (hours: number, maxHours = 72) => Number.isInteger(hours) && hours >= 1 && hours <= maxHours;
const STORY_HOUR_CHOICES = [1, 3, 6, 12, 24, 48, 72];

const enabled = async () => Boolean(await getConfigValue<boolean>('STORIES.ENABLED', true));
const defaultHours = async () => { const v = await getConfigValue<number>('STORIES.DEFAULT_HOURS', 24); return typeof v === 'number' ? v : 24; };
const maxHours = async () => { const v = await getConfigValue<number>('STORIES.MAX_HOURS', 72); return typeof v === 'number' ? v : 72; };

/** Réglages publics des stories (le mobile ne code rien en dur). */
export async function settings() {
  const max = await maxHours();
  return { enabled: await enabled(), defaultHours: await defaultHours(), maxHours: max, hoursOptions: STORY_HOUR_CHOICES.filter((h) => h <= max) };
}

/** Peut-on voir les stories de cet auteur ? Compte actif, profil non suspendu, pas de blocage, profil public ou abonné. */
async function canSee(viewer: User, authorId: string): Promise<boolean> {
  if (authorId === viewer.id) return true;
  const author = await prisma.user.findUnique({ where: { id: authorId }, select: { status: true, profileModerationStatus: true, profileVisibility: true } });
  if (!author || author.status !== 'ACTIVE' || author.profileModerationStatus !== 'ACTIVE') return false;
  if ((await blockedIdsFor(viewer.id)).includes(authorId)) return false;
  const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer.id, followingId: authorId } }, select: { id: true } });
  return !contentLocked(author, false, !!follow);
}

const dto = (s: { id: string; authorId: string; mediaKey: string; mediaType: string; mediaMime: string; mediaSize: number; caption: string | null; createdAt: Date; expiresAt: Date }, seen: boolean) => ({
  id: s.id, authorId: s.authorId, mediaType: s.mediaType, caption: s.caption, createdAt: s.createdAt, expiresAt: s.expiresAt, seen,
  media: { url: objectStorage.privateReadUrl(s.mediaKey) || null, mimeType: s.mediaMime, sizeBytes: s.mediaSize },
});

/** Demande d'envoi d'un média de story (photo ou vidéo) vers le stockage privé. */
export async function requestUpload(viewer: User, b: { contentType: string; sizeBytes: number }) {
  if (!(await enabled())) throw forbidden('STORIES_DISABLED', 'Les stories sont désactivées');
  const isImage = !!MESSAGE_IMAGE_MIME[b.contentType];
  const ext = MESSAGE_IMAGE_MIME[b.contentType] ?? MESSAGE_VIDEO_MIME[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_STORY', 'Format non pris en charge (images JPEG, PNG, WebP ; vidéos MP4, MOV, WebM)');
  const max = isImage ? env.STORY_IMAGE_MAX_BYTES : env.STORY_VIDEO_MAX_BYTES;
  if (b.sizeBytes > max) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(max / 1_048_576)} Mo maximum)`);
  const key = `stories/${viewer.id}/${randomToken(10)}.${ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

/** Publication d'une story après téléversement : vérifie la propriété du fichier, son format, sa taille, et la durée choisie. */
export async function publish(viewer: User, b: { mediaKey: string; caption?: string; hours?: number }) {
  if (!(await enabled())) throw forbidden('STORIES_DISABLED', 'Les stories sont désactivées');
  const max = await maxHours();
  const hours = b.hours ?? (await defaultHours());
  if (!isValidStoryHours(hours, max)) throw badRequest('INVALID_STORY_DURATION', `Durée de 1 à ${max} heures`);
  if (!b.mediaKey.startsWith(`stories/${viewer.id}/`)) throw badRequest('INVALID_MEDIA', 'Média invalide');
  const ext = b.mediaKey.split('.').pop() ?? '';
  const mime = Object.entries({ ...MESSAGE_IMAGE_MIME, ...MESSAGE_VIDEO_MIME }).find(([, e]) => e === ext)?.[0];
  if (!mime) throw badRequest('INVALID_MEDIA', 'Média invalide');
  const info = await objectStorage.head(b.mediaKey);
  if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
  const maxBytes = MESSAGE_IMAGE_MIME[mime] ? env.STORY_IMAGE_MAX_BYTES : env.STORY_VIDEO_MAX_BYTES;
  if (info.size < 1 || info.size > maxBytes || (info.contentType && info.contentType.toLowerCase() !== mime)) {
    await dropObject(b.mediaKey);
    throw badRequest('INVALID_MEDIA', 'Fichier invalide');
  }
  try {
    const story = await prisma.story.create({
      data: { authorId: viewer.id, mediaKey: b.mediaKey, mediaType: mediaTypeOf(mime), mediaMime: mime, mediaSize: info.size, caption: b.caption?.trim() || null, hours, expiresAt: new Date(Date.now() + hours * HOUR_MS) },
    });
    return { story: dto(story, false) };
  } catch (e) {
    if (isUnique(e)) throw conflict('MEDIA_ALREADY_USED', 'Ce média a déjà été publié');
    throw e;
  }
}

/** Mes stories en cours, avec qui les a vues (pour l'auteur). */
export async function mine(viewer: User) {
  const rows = await prisma.story.findMany({
    where: { authorId: viewer.id, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: { views: { orderBy: { viewedAt: 'asc' }, include: { viewer: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } } },
  });
  return {
    items: rows.map((r) => ({
      ...dto(r, true),
      viewers: r.views.map((v) => ({ userId: v.viewer.id, username: v.viewer.username, displayName: v.viewer.displayName, avatarUrl: v.viewer.avatarUrl, viewedAt: v.viewedAt })),
    })),
  };
}

/** Stories visibles d'un utilisateur (anneau autour de l'avatar) : vide si pas autorisé, si désactivé, ou s'il n'en a pas. */
export async function storiesOf(viewer: User, userId: string) {
  if (!(await enabled()) || !(await canSee(viewer, userId))) return { stories: [], allSeen: true };
  const rows = await prisma.story.findMany({
    where: { authorId: userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: { views: { where: { viewerId: viewer.id }, select: { viewerId: true } } },
  });
  const stories = rows.map((r) => dto(r, r.views.length > 0));
  return { stories, allSeen: stories.every((s) => s.seen) };
}

/** Marque une story comme vue par le spectateur (une seule fois, sans effet pour l'auteur). */
export async function markViewed(viewer: User, storyId: string) {
  const s = await prisma.story.findUnique({ where: { id: storyId }, select: { authorId: true, expiresAt: true } });
  if (!s || s.expiresAt <= new Date() || !(await canSee(viewer, s.authorId))) throw notFound('Story introuvable');
  if (s.authorId === viewer.id) return;
  await prisma.storyView.upsert({ where: { storyId_viewerId: { storyId, viewerId: viewer.id } }, create: { storyId, viewerId: viewer.id }, update: {} });
}

/** Suppression par l'auteur : le fichier et la story disparaissent. Un tiers reçoit 404. */
export async function remove(viewer: User, storyId: string) {
  const s = await prisma.story.findUnique({ where: { id: storyId }, select: { authorId: true, mediaKey: true } });
  if (!s || s.authorId !== viewer.id) throw notFound('Story introuvable');
  await dropObject(s.mediaKey);
  await prisma.story.deleteMany({ where: { id: storyId } });
}

/** Purge des stories arrivées à échéance : fichier puis ligne (les vues suivent par cascade). Renvoie le nombre supprimé. */
export async function purgeExpiredStories(now: Date = new Date()): Promise<number> {
  const due = await prisma.story.findMany({ where: { expiresAt: { lte: now } }, select: { id: true, mediaKey: true }, take: 200 });
  let purged = 0;
  for (const s of due) {
    try { await objectStorage.delete(s.mediaKey); } catch (e) { console.error(`[stories] purge du fichier impossible (story ${s.id}), nouvel essai au prochain passage`, e); continue; }
    await prisma.story.deleteMany({ where: { id: s.id } });
    purged++;
  }
  return purged;
}

/** Lance la purge périodique (sans effet en test). */
export function startStorySweeper(intervalMs = 60_000) {
  if (env.NODE_ENV === 'test') return null;
  const timer = setInterval(() => { purgeExpiredStories().catch((e) => console.error('[stories] passage de purge en échec', e)); }, intervalMs);
  timer.unref();
  return timer;
}
