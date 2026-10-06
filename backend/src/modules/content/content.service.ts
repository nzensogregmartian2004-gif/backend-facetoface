import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { randomToken } from '../../utils/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { objectStorage } from '../../utils/objectStorage';
import { loadOwned, loadVisible } from './access';
import { serializeMany, serializeOne } from './content.serializer';
import { processContent } from './videoPipeline.service';
import { IMAGE_MIME, KINDS, VIDEO_MIME, repo, type ContentWithAuthor, type Kind } from './types';

type Meta = { title: string; description?: string | null; category: string; visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; allowDownload?: boolean; subscriptionOnly?: boolean; allowComments?: boolean };

/** Suppression « au mieux » d'un objet : un échec de stockage ne doit jamais bloquer l'opération métier (le nettoyage sera repris à l'étape 21). */
async function dropObject(key: string | null | undefined) {
  if (!key) return;
  try { await objectStorage.delete(key); } catch (e) { console.warn('[stockage] suppression impossible :', key, (e as Error).message); }
}

export async function createDraft(user: User, kind: Kind, m: Meta) {
  if (!user.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur pour publier du contenu');
  const row = await repo(prisma, kind).create({
    data: { authorId: user.id, title: m.title, description: m.description ?? null, category: m.category, visibility: m.visibility ?? 'PUBLIC', allowDownload: m.allowDownload ?? false, subscriptionOnly: m.subscriptionOnly ?? false, allowComments: m.allowComments ?? true },
    include: { author: true },
  });
  return serializeOne(kind, row, user);
}

export async function listMine(user: User, kind: Kind, o: { cursor?: string; limit: number; status?: 'DRAFT' | 'PUBLISHED' | 'HIDDEN' }) {
  const cursorId = readIdCursor(o.cursor);
  const rows: ContentWithAuthor[] = await repo(prisma, kind).findMany({
    where: { authorId: user.id, status: o.status ?? { not: 'REMOVED' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: true },
  });
  const page = rows.slice(0, o.limit);
  return { items: await serializeMany(kind, page, user), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}

export async function getOne(user: User, kind: Kind, id: string) {
  return serializeOne(kind, await loadVisible(user, kind, id), user);
}

export async function update(user: User, kind: Kind, id: string, patch: Partial<Meta>) {
  await loadOwned(user, kind, id);
  const row = await repo(prisma, kind).update({ where: { id }, data: patch, include: { author: true } });
  return serializeOne(kind, row, user);
}

export async function remove(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  await repo(prisma, kind).update({ where: { id }, data: { status: 'REMOVED', deletedAt: new Date() } });
  const variants = await prisma.videoVariant.findMany({ where: kind === 'VIDEO' ? { videoId:id } : { shortId:id }, select:{objectKey:true} });
  await Promise.all([dropObject(row.videoKey), dropObject(row.thumbnailKey), dropObject(row.manifestKey), ...variants.map(v=>dropObject(v.objectKey))]);
  await prisma.videoVariant.deleteMany({ where: kind === 'VIDEO' ? { videoId:id } : { shortId:id } });
}

/** Étape 1 de l'envoi : le serveur choisit la clé d'objet et renvoie une URL pré-signée ; le mobile envoie le fichier directement au stockage. */
export async function requestUpload(user: User, kind: Kind, id: string, b: { file: 'video' | 'thumbnail'; contentType: string; sizeBytes: number }) {
  const row = await loadOwned(user, kind, id);
  const isVideo = b.file === 'video';
  const ext = (isVideo ? VIDEO_MIME : IMAGE_MIME)[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', isVideo ? 'Format vidéo non pris en charge (MP4, MOV ou WebM)' : 'Image non prise en charge (JPEG, PNG ou WebP)');
  const max = isVideo ? KINDS[kind].maxBytes() : env.THUMBNAIL_MAX_BYTES;
  if (b.sizeBytes > max) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(max / 1_048_576)} Mo maximum)`);
  if (isVideo && row.status === 'PUBLISHED') throw conflict('ALREADY_PUBLISHED', 'La vidéo est déjà publiée : créez un nouveau contenu pour changer le fichier');
  const key = `${KINDS[kind].keyPrefix}/${id}/${isVideo ? 'source' : 'thumb'}-${randomToken(6)}.${ext}`;
  const upload = objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS); // peut répondre 503 si le stockage n'est pas configuré
  const old = isVideo ? row.videoKey : row.thumbnailKey;
  await repo(prisma, kind).update({
    where: { id },
    data: isVideo ? { videoKey: key, mimeType: b.contentType, sizeBytes: null, uploadedAt: null, durationSeconds: null, width: null, height: null, processingStatus: 'PENDING', processingError: null, processedAt: null, manifestKey: null } : { thumbnailKey: key },
  });
  await dropObject(old);
  return { upload: { ...upload, key } };
}

/** Étape 2 : le client confirme la fin de l'envoi ; le serveur VÉRIFIE auprès du stockage (existence, taille) avant d'accepter. */
export async function completeUpload(user: User, kind: Kind, id: string, b: { durationSeconds: number; width?: number; height?: number }) {
  const row = await loadOwned(user, kind, id);
  if (!row.videoKey) throw conflict('NO_UPLOAD', "Demandez d'abord une URL d'envoi");
  const info = await objectStorage.head(row.videoKey);
  if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
  if (info.size < 1 || info.size > KINDS[kind].maxBytes()) {
    await dropObject(row.videoKey);
    await repo(prisma, kind).update({ where: { id }, data: { videoKey: null, mimeType: null, sizeBytes: null } });
    throw badRequest('FILE_TOO_LARGE', 'Fichier vide ou trop volumineux');
  }
  if (kind === 'SHORT') {
    if (b.durationSeconds > env.SHORT_MAX_SECONDS) throw badRequest('SHORT_TOO_LONG', `Un Short dure ${env.SHORT_MAX_SECONDS} secondes maximum`);
    if (b.width && b.height && b.height < b.width) throw badRequest('SHORT_NOT_VERTICAL', 'Un Short doit être une vidéo verticale');
  }
  let thumbnailKey = row.thumbnailKey;
  if (thumbnailKey) {
    const t = await objectStorage.head(thumbnailKey);
    if (!t || t.size < 1 || t.size > env.THUMBNAIL_MAX_BYTES) { await dropObject(thumbnailKey); thumbnailKey = null; } // miniature absente ou invalide : ignorée
  }
  const updated = await repo(prisma, kind).update({
    where: { id },
    data: { sizeBytes: info.size, durationSeconds: b.durationSeconds, width: b.width ?? null, height: b.height ?? null, uploadedAt: new Date(), thumbnailKey, processingStatus: 'PROCESSING', processingError: null, processedAt: null, manifestKey: null },
    include: { author: true },
  });
  try { await processContent(kind, id); } catch { /* état FAILED conservé pour reprise/admin */ }
  const ready = await repo(prisma, kind).findUnique({ where:{id}, include:{author:true} });
  return serializeOne(kind, ready, user);
}

export async function publish(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  if (row.status === 'HIDDEN') throw forbidden('CONTENT_HIDDEN', 'Ce contenu a été masqué par la modération');
  if (row.status === 'PUBLISHED') return serializeOne(kind, row, user);
  if (!row.videoKey || !row.uploadedAt || !row.durationSeconds) throw conflict('UPLOAD_INCOMPLETE', "Envoyez et confirmez le fichier vidéo avant de publier");
  if (row.processingStatus !== 'READY') throw conflict('VIDEO_PROCESSING', row.processingStatus === 'FAILED' ? 'Le traitement vidéo a échoué' : 'La vidéo est encore en cours de traitement');
  const updated = await repo(prisma, kind).update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() }, include: { author: true } });
  return serializeOne(kind, updated, user);
}

/** URL de lecture. Réservée aux contenus que le spectateur a le droit de voir. */
export async function playback(user: User, kind: Kind, id: string) {
  const row = await loadVisible(user, kind, id);
  if (!row.videoKey || !row.uploadedAt) throw conflict('NOT_READY', "La vidéo n'est pas encore disponible");
  const ttl = env.PLAYBACK_URL_TTL_SECONDS;
  const useHls = !!env.CDN_URL && !!row.manifestKey && !row.subscriptionOnly && row.visibility === 'PUBLIC';
  const playbackKey = useHls ? row.manifestKey! : row.videoKey;
  const url = objectStorage.readUrl(playbackKey, ttl);
  if (!url) throw notFound('Vidéo indisponible');
  return { playback: { url, mimeType: useHls ? 'application/vnd.apple.mpegurl' : row.mimeType, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } };
}

/** Téléchargement contrôlé : interdit par défaut, autorisé contenu par contenu par le créateur, désactivable globalement. */
export async function downloadUrl(user: User, kind: Kind, id: string) {
  if (!env.DOWNLOADS_ENABLED) throw forbidden('DOWNLOADS_DISABLED', 'Les téléchargements sont désactivés');
  const row = await loadVisible(user, kind, id);
  if (!row.allowDownload) throw forbidden('DOWNLOAD_NOT_ALLOWED', "Le créateur n'autorise pas le téléchargement de ce contenu");
  if (!row.videoKey || !row.uploadedAt) throw conflict('NOT_READY', "La vidéo n'est pas encore disponible");
  const ext = row.mimeType ? VIDEO_MIME[row.mimeType] ?? 'mp4' : 'mp4';
  const ttl = env.PLAYBACK_URL_TTL_SECONDS;
  return { download: { url: objectStorage.downloadUrl(row.videoKey, `${row.title}.${ext}`, ttl), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } };
}
