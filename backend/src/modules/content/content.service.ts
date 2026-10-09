import { playbackPlan } from './playback.policy';
import { blockedIdsFor } from './access';
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
import { isProcessingStale, isRestrictedContent, shouldPurgePublicHls } from './processing.policy';
import { abortUploadSession } from './multipart.service';
import { normalizeEdit, type VideoEditInput } from './edit.policy';
import { clearContentTags, syncContentTags } from '../discovery/tags.service';

/** Hashtags et mentions : une erreur ici ne doit jamais bloquer une publication (rattrapable par `npm run tags:backfill`). */
async function tagsSafely(kind: Kind, id: string, action: 'sync' | 'clear') {
  try { await (action === 'sync' ? syncContentTags(kind, id) : clearContentTags(kind, id)); }
  catch (e) { console.warn('[découverte] hashtags impossibles :', id, (e as Error).message); }
}
import { assertPriceInRange, isSupportedCurrency } from '../../utils/currency';
import { IMAGE_MIME, KINDS, VIDEO_MIME, repo, type ContentWithAuthor, type Kind } from './types';

type Meta = { title: string; description?: string | null; category: string; visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; allowDownload?: boolean; subscriptionOnly?: boolean; allowComments?: boolean; price?: number | null; currency?: string | null };

/** Suppression « au mieux » d'un objet : un échec de stockage ne doit jamais bloquer l'opération métier (le nettoyage sera repris à l'étape 21). */
async function dropObject(key: string | null | undefined) {
  if (!key) return;
  try { await objectStorage.delete(key); } catch (e) { console.warn('[stockage] suppression impossible :', key, (e as Error).message); }
}

function paidData(m: Pick<Meta, 'price' | 'currency'>) {
  if (m.price == null && m.currency == null) return { price: null, currency: null };
  if (m.price == null || !m.currency) throw badRequest('INVALID_PAID_CONTENT', 'Prix et devise doivent être fournis ensemble');
  const currency = m.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) throw badRequest('UNSUPPORTED_CURRENCY', 'Devise non prise en charge');
  assertPriceInRange(m.price, currency, env.PAID_CONTENT_MIN_FCFA, env.PAID_CONTENT_MAX_FCFA, 'INVALID_CONTENT_PRICE');
  return { price: m.price, currency };
}

export async function createDraft(user: User, kind: Kind, m: Meta) {
  if (!user.isCreator) throw forbidden('CREATOR_REQUIRED', 'Activez les fonctions créateur pour publier du contenu');
  const row = await repo(prisma, kind).create({
    data: { authorId: user.id, title: m.title, description: m.description ?? null, category: m.category, visibility: m.visibility ?? 'PUBLIC', allowDownload: m.allowDownload ?? false, subscriptionOnly: m.subscriptionOnly ?? false, allowComments: m.allowComments ?? true, ...paidData(m) },
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
  const current = await loadOwned(user, kind, id);
  const nextPrice = patch.price !== undefined ? patch.price : current.price;
  const nextCurrency = patch.currency !== undefined ? patch.currency : current.currency;
  const paid = paidData({ price: nextPrice, currency: nextCurrency });
  const restrictedAfter = isRestrictedContent({
    paid: paid.price != null,
    subscriptionOnly: patch.subscriptionOnly ?? current.subscriptionOnly,
    visibility: patch.visibility ?? current.visibility,
  });
  // Un contenu public déjà transcodé qui devient payant / réservé : ses playlists publiques sont retirées AVANT la mise à jour
  // (en cas d'échec ensuite, le contenu reste lisible uniquement par URL signée, jamais l'inverse).
  const purge = shouldPurgePublicHls({ manifestKey: current.manifestKey, videoKey: current.videoKey }, restrictedAfter);
  if (purge && current.processingStatus === 'PROCESSING') throw conflict('PROCESSING_IN_PROGRESS', 'Le traitement est en cours : verrouillez la vidéo une fois le traitement terminé');
  if (purge) await purgePublicHls(kind, id); // une erreur de stockage empêche le verrouillage (rien n'est changé)
  const row = await repo(prisma, kind).update({
    where: { id },
    data: { ...patch, ...paid, ...(purge ? { manifestKey: null } : {}) },
    include: { author: true },
  });
  await tagsSafely(kind, id, 'sync'); // titre ou description modifiés : hashtags et mentions à jour
  return serializeOne(kind, row, user);
}

/**
 * Retire TOUTES les playlists et tous les segments publics d'un contenu (lot 3). Une erreur de stockage est remontée :
 * le verrouillage n'est appliqué que si la purge a réussi.
 */
async function purgePublicHls(kind: Kind, id: string) {
  await objectStorage.deletePrefix(`${KINDS[kind].keyPrefix}/${id}/hls/`);
  await prisma.videoVariant.deleteMany({ where: kind === 'VIDEO' ? { videoId: id } : { shortId: id } });
}

/**
 * Nouvel essai du traitement (lot 2). Possible si le fichier a été reçu et si le traitement a échoué, ou s'il est resté
 * bloqué en PROCESSING au-delà du délai. Un contenu déjà prêt est renvoyé tel quel.
 */
export async function retryProcessing(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  if (!row.videoKey || !row.uploadedAt) throw conflict('NO_UPLOAD', "Envoyez d'abord le fichier vidéo");
  const restricted = isRestrictedContent({ paid: row.price != null, subscriptionOnly: row.subscriptionOnly, visibility: row.visibility });
  if (row.processingStatus === 'READY' && shouldPurgePublicHls({ manifestKey: row.manifestKey, videoKey: row.videoKey }, restricted)) {
    // Contenu réservé qui garde une ancienne playlist publique : on la retire, c'est la correction attendue.
    await purgePublicHls(kind, id);
    return serializeOne(kind, await repo(prisma, kind).update({ where: { id }, data: { manifestKey: null }, include: { author: true } }), user);
  }
  if (row.processingStatus === 'READY' && (restricted || row.manifestKey)) return serializeOne(kind, row, user); // déjà cohérent
  if (row.processingStatus === 'PROCESSING' && !isProcessingStale(row.updatedAt)) throw conflict('PROCESSING_IN_PROGRESS', 'Le traitement est déjà en cours');
  await repo(prisma, kind).update({ where: { id }, data: { processingStatus: 'PROCESSING', processingError: null } });
  try { await processContent(kind, id); } catch { /* état FAILED conservé : le créateur peut réessayer */ }
  const ready = await repo(prisma, kind).findUnique({ where: { id }, include: { author: true } });
  return serializeOne(kind, ready, user);
}

export async function remove(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  await repo(prisma, kind).update({ where: { id }, data: { status: 'REMOVED', deletedAt: new Date() } });
  const variants = await prisma.videoVariant.findMany({ where: kind === 'VIDEO' ? { videoId:id } : { shortId:id }, select:{objectKey:true} });
  await Promise.all([dropObject(row.videoKey), dropObject(row.thumbnailKey), dropObject(row.manifestKey), ...variants.map(v=>dropObject(v.objectKey))]);
  await prisma.videoVariant.deleteMany({ where: kind === 'VIDEO' ? { videoId:id } : { shortId:id } });
  await tagsSafely(kind, id, 'clear');
  await abortUploadSession(kind, id);
  try { await objectStorage.deletePrefix(`${KINDS[kind].keyPrefix}/${id}/hls/`); } catch (e) { console.warn('[stockage] purge HLS impossible à la suppression :', id, (e as Error).message); }
}

/** Étape 1 de l'envoi : le serveur choisit la clé d'objet et renvoie une URL pré-signée ; le mobile envoie le fichier directement au stockage. */
export async function requestUpload(user: User, kind: Kind, id: string, b: { file: 'video' | 'thumbnail'; contentType: string; sizeBytes: number }) {
  const row = await loadOwned(user, kind, id);
  const isVideo = b.file === 'video';
  if (isVideo) await abortUploadSession(kind, id);
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
    data: isVideo ? { videoKey: key, mimeType: b.contentType, sizeBytes: null, uploadedAt: null, durationSeconds: null, width: null, height: null, processingStatus: 'PENDING', processingError: null, processedAt: null, manifestKey: null, editStartMs: null, editEndMs: null, coverMs: null } : { thumbnailKey: key },
  });
  await dropObject(old);
  return { upload: { ...upload, key } };
}

/** Étape 2 : le client confirme la fin de l'envoi ; le serveur VÉRIFIE auprès du stockage (existence, taille) avant d'accepter. */
export async function completeUpload(user: User, kind: Kind, id: string, b: { durationSeconds: number; width?: number; height?: number; edit?: VideoEditInput }) {
  const row = await loadOwned(user, kind, id);
  if (!row.videoKey) throw conflict('NO_UPLOAD', "Demandez d'abord une URL d'envoi");
  const info = await objectStorage.head(row.videoKey);
  if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
  if (info.size < 1 || info.size > KINDS[kind].maxBytes()) {
    await dropObject(row.videoKey);
    await repo(prisma, kind).update({ where: { id }, data: { videoKey: null, mimeType: null, sizeBytes: null } });
    throw badRequest('FILE_TOO_LARGE', 'Fichier vide ou trop volumineux');
  }
  const edit = normalizeEdit(b.edit, b.durationSeconds, kind, env.SHORT_MAX_SECONDS);
  if (!edit.ok) throw badRequest(edit.code, edit.message);
  if (kind === 'SHORT') {
    if (b.width && b.height && b.height < b.width) throw badRequest('SHORT_NOT_VERTICAL', 'Un Short doit être une vidéo verticale');
  }
  let thumbnailKey = row.thumbnailKey;
  if (thumbnailKey) {
    const t = await objectStorage.head(thumbnailKey);
    if (!t || t.size < 1 || t.size > env.THUMBNAIL_MAX_BYTES) { await dropObject(thumbnailKey); thumbnailKey = null; } // miniature absente ou invalide : ignorée
  }
  const updated = await repo(prisma, kind).update({
    where: { id },
    data: { sizeBytes: info.size, durationSeconds: edit.effectiveSeconds, editStartMs: edit.trimStartMs, editEndMs: edit.trimEndMs, coverMs: edit.coverMs, width: b.width ?? null, height: b.height ?? null, uploadedAt: new Date(), thumbnailKey, processingStatus: 'PROCESSING', processingError: null, processedAt: null, manifestKey: null },
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
  await tagsSafely(kind, id, 'sync');
  return serializeOne(kind, updated, user);
}

/** URL de lecture. Réservée aux contenus que le spectateur a le droit de voir. Le mode dépend de la règle pure playbackPlan. */
export async function playback(user: User, kind: Kind, id: string) {
  const row = await loadVisible(user, kind, id);
  const paid = row.price != null && row.authorId !== user.id;
  if (paid) {
    const purchase = await prisma.paidContentPurchase.findUnique({ where: { contentType_contentId_buyerId: { contentType: kind, contentId: id, buyerId: user.id } }, select: { status: true } });
    if (purchase?.status !== 'PAID') throw forbidden('CONTENT_PURCHASE_REQUIRED', 'Achetez ce contenu pour y accéder');
  }
  if (!row.videoKey || !row.uploadedAt) throw conflict('NOT_READY', "La vidéo n'est pas encore disponible");
  const plan = playbackPlan(
    { paid, subscriptionOnly: row.subscriptionOnly, visibility: row.visibility, hasCdn: !!env.CDN_URL, hasManifest: !!row.manifestKey },
    { standardTtl: env.PLAYBACK_URL_TTL_SECONDS, paidTtl: env.PAID_PLAYBACK_URL_TTL_SECONDS },
  );
  const expiresAt = new Date(Date.now() + plan.ttlSeconds * 1000).toISOString();
  if (plan.mode === 'HLS_PUBLIC') {
    // Gratuit public uniquement : le CDN public est acceptable, rien n'est à protéger.
    const url = objectStorage.readUrl(row.manifestKey!, plan.ttlSeconds);
    if (!url) throw notFound('Vidéo indisponible');
    const variants = await prisma.videoVariant.findMany({
      where: kind === 'VIDEO' ? { videoId: id } : { shortId: id }, orderBy: { height: 'desc' },
      select: { height: true, width: true, bitrateKbps: true, objectKey: true },
    });
    return {
      playback: { url, mimeType: 'application/vnd.apple.mpegurl', expiresAt, mode: plan.mode },
      variants: variants.map((v) => ({ height: v.height, width: v.width, bitrateKbps: v.bitrateKbps, url: objectStorage.readUrl(v.objectKey, plan.ttlSeconds) })),
    };
  }
  // Accès restreint : toujours une URL signée de courte durée. Pas de choix de qualité : le fichier d'origine est servi.
  const url = objectStorage.privateReadUrl(row.videoKey, plan.ttlSeconds);
  if (!url) throw notFound('Vidéo indisponible');
  return { playback: { url, mimeType: row.mimeType, expiresAt, mode: plan.mode }, variants: [] as Array<{ height: number; width: number | null; bitrateKbps: number | null; url: string }> };
}

/** Vidéos similaires : même catégorie, publiées, visibles, hors abonnés-seuls, sans auteurs bloqués ni le contenu lui-même. */
export async function similar(user: User, kind: Kind, id: string, limit = 12) {
  const base = await loadVisible(user, kind, id);
  const blocked = await blockedIdsFor(user.id);
  const rows = await repo(prisma, kind).findMany({
    where: {
      id: { not: id }, category: base.category, status: 'PUBLISHED', visibility: 'PUBLIC', subscriptionOnly: false,
      deletedAt: null, processingStatus: 'READY', authorId: { notIn: blocked },
    },
    orderBy: { publishedAt: 'desc' }, take: limit, include: { author: true },
  });
  return rows.map((r) => serializeOne(kind, r, user));
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
