import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { randomToken } from '../../utils/crypto';
import { badRequest, conflict } from '../../utils/errors';
import { objectStorage } from '../../utils/objectStorage';
import { loadOwned } from './access';
import { isValidPartNumber, missingParts, multipartPlan } from './multipart.policy';
import { KINDS, VIDEO_MIME, repo, type Kind } from './types';

/**
 * Envoi par parties d'une vidéo (étape 10, lot 3). Le serveur garde l'identifiant d'envoi ; le mobile envoie les parties
 * directement au stockage avec des URL pré-signées. Une reprise après coupure ou redémarrage relit les parties reçues.
 */
const keyOf = (kind: Kind, id: string) => ({ contentType_contentId: { contentType: kind, contentId: id } });
const findSession = (kind: Kind, id: string) => prisma.contentUploadSession.findUnique({ where: keyOf(kind, id) });

/** Annule l'envoi en cours s'il existe : ses parties sont libérées côté stockage. */
export async function abortUploadSession(kind: Kind, id: string) {
  const s = await findSession(kind, id);
  if (!s) return;
  try { await objectStorage.abortMultipart(s.key, s.uploadId); } catch (e) { console.warn('[stockage] annulation d\'envoi impossible :', (e as Error).message); }
  await prisma.contentUploadSession.delete({ where: { id: s.id } }).catch(() => undefined);
}

/** Session valable seulement si elle correspond encore au fichier actuel du contenu. */
async function currentSession(kind: Kind, id: string, currentKey: string | null) {
  const s = await findSession(kind, id);
  if (!s || s.key !== currentKey) throw conflict('NO_MULTIPART_UPLOAD', "Demandez d'abord le début de l'envoi");
  return s;
}

export async function startMultipart(user: User, kind: Kind, id: string, b: { sizeBytes: number; contentType: string }) {
  const row = await loadOwned(user, kind, id);
  const ext = VIDEO_MIME[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', 'Format vidéo non pris en charge (MP4, MOV ou WebM)');
  if (b.sizeBytes > KINDS[kind].maxBytes()) throw badRequest('FILE_TOO_LARGE', `Fichier trop volumineux (${Math.floor(KINDS[kind].maxBytes() / 1_048_576)} Mo maximum)`);
  if (row.status === 'PUBLISHED') throw conflict('ALREADY_PUBLISHED', 'La vidéo est déjà publiée : créez un nouveau contenu pour changer le fichier');
  await abortUploadSession(kind, id); // on repart d'un envoi propre
  const key = `${KINDS[kind].keyPrefix}/${id}/source-${randomToken(6)}.${ext}`;
  const uploadId = await objectStorage.createMultipart(key, b.contentType);
  const plan = multipartPlan(b.sizeBytes);
  const old = row.videoKey;
  await repo(prisma, kind).update({
    where: { id },
    data: { videoKey: key, mimeType: b.contentType, sizeBytes: null, uploadedAt: null, durationSeconds: null, width: null, height: null, processingStatus: 'PENDING', processingError: null, processedAt: null, manifestKey: null, editStartMs: null, editEndMs: null, coverMs: null },
  });
  await prisma.contentUploadSession.create({
    data: { contentType: kind, contentId: id, key, uploadId, sizeBytes: b.sizeBytes, partSizeBytes: plan.partSizeBytes, partCount: plan.partCount },
  });
  if (old) { try { await objectStorage.delete(old); } catch { /* nettoyage au mieux */ } }
  return { uploadId, key, sizeBytes: b.sizeBytes, partSizeBytes: plan.partSizeBytes, partCount: plan.partCount };
}

/** Ce qui est déjà reçu par le stockage, pour reprendre l'envoi sans tout renvoyer. */
export async function multipartStatus(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  const s = await findSession(kind, id);
  if (!s || s.key !== row.videoKey) return { session: null };
  const parts = await objectStorage.listParts(s.key, s.uploadId);
  return {
    session: {
      uploadId: s.uploadId, sizeBytes: s.sizeBytes, partSizeBytes: s.partSizeBytes, partCount: s.partCount,
      uploaded: parts.map((p) => p.partNumber).sort((a, b) => a - b),
    },
  };
}

export async function multipartPartUrl(user: User, kind: Kind, id: string, partNumber: number) {
  const row = await loadOwned(user, kind, id);
  const s = await currentSession(kind, id, row.videoKey);
  if (!isValidPartNumber(partNumber, s.partCount)) throw badRequest('INVALID_PART', `Numéro de partie invalide (1 à ${s.partCount})`);
  return {
    partNumber,
    url: objectStorage.presignPart(s.key, s.uploadId, partNumber, env.UPLOAD_URL_TTL_SECONDS),
    expiresAt: new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Finalisation : le serveur lit lui-même les parties reçues (il n'accepte pas les ETag du mobile) et vérifie
 * qu'il y en a toutes, et que leur taille totale correspond au fichier annoncé.
 */
export async function multipartComplete(user: User, kind: Kind, id: string) {
  const row = await loadOwned(user, kind, id);
  const s = await currentSession(kind, id, row.videoKey);
  const parts = await objectStorage.listParts(s.key, s.uploadId);
  const missing = missingParts(parts.map((p) => p.partNumber), s.partCount);
  if (missing.length) throw conflict('PARTS_MISSING', `Il manque ${missing.length} partie(s) de l'envoi`, { missing });
  const total = parts.reduce((n, p) => n + p.size, 0);
  if (total !== s.sizeBytes) {
    await abortUploadSession(kind, id);
    throw conflict('SIZE_MISMATCH', "La taille reçue ne correspond pas au fichier annoncé : recommencez l'envoi");
  }
  await objectStorage.completeMultipart(s.key, s.uploadId, parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  await prisma.contentUploadSession.delete({ where: { id: s.id } }).catch(() => undefined);
  return { completed: true, partCount: s.partCount, sizeBytes: total };
}

export async function multipartAbort(user: User, kind: Kind, id: string) {
  await loadOwned(user, kind, id);
  await abortUploadSession(kind, id);
  return { aborted: true };
}
