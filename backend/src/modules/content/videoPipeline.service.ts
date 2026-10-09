import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { randomToken } from '../../utils/crypto';
import { objectStorage } from '../../utils/objectStorage';
import { cleanupTranscodeDir, generateThumbnail, listFiles, transcodeToHls, trimVideo } from '../../utils/videoTranscoder';
import { isRestrictedContent } from './processing.policy';
import type { Kind } from './types';

const mime = (file: string) => file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';

/**
 * Traitement d'un contenu après envoi.
 * - Étape 13 : si le créateur a découpé la vidéo, la copie découpée remplace la source (même pour un contenu payant,
 *   qui est servi en fichier direct). La couverture est prise à `coverMs` dans la vidéo découpée.
 * - Étape 10 : un contenu réservé (payant, abonnés seuls, non public) n'est JAMAIS transcodé en HLS public.
 * - Un contenu sans dimensions connues passe en FAILED. Chaque étape est rejouable : un nouvel essai reprend là où il s'est arrêté.
 */
export async function processContent(kind: Kind, id: string) {
  const db = prisma as any;
  const content = kind === 'VIDEO' ? db.video : db.short;
  const row = await content.findUnique({
    where: { id },
    select: { id: true, videoKey: true, mimeType: true, width: true, height: true, thumbnailKey: true, price: true, subscriptionOnly: true, visibility: true, editStartMs: true, editEndMs: true, coverMs: true },
  });
  if (!row?.videoKey) return;
  const fail = (message: string) => content.update({ where: { id }, data: { processingStatus: 'FAILED', processingError: message.slice(0, 1000) } });
  if (!row.width || !row.height) { await fail('Dimensions de la vidéo inconnues : renvoyez le fichier'); return; }
  const restricted = isRestrictedContent({ paid: row.price != null, subscriptionOnly: !!row.subscriptionOnly, visibility: row.visibility });
  const dir = kind === 'VIDEO' ? 'videos' : 'shorts';

  if (env.STORAGE_DRIVER === 'memory') {
    // Mode mémoire (tests) : pas de ffmpeg. Le fichier source fait office de manifeste pour un contenu public, rien pour un contenu réservé.
    await content.update({ where: { id }, data: { processingStatus: 'READY', processedAt: new Date(), processingError: null, manifestKey: restricted ? null : row.videoKey, editStartMs: null, editEndMs: null } });
    return;
  }

  await content.update({ where: { id }, data: { processingStatus: 'PROCESSING', processingError: null } });
  const work = await fs.mkdtemp(path.join(env.UPLOAD_DIR, '.transcode-')).catch(() => fs.mkdtemp(path.join('/tmp', 'f2f-transcode-')));
  const source = path.join(work, 'source.' + ((row.mimeType || 'video/mp4').split('/')[1] || 'mp4'));
  try {
    await objectStorage.downloadToFile(row.videoKey, source);

    // Étape 13 : découpage demandé. La copie découpée devient la vidéo du contenu ; l'ancienne source est retirée ensuite.
    let current = source;
    if (row.editStartMs != null && row.editEndMs != null) {
      const edited = path.join(work, 'edited.mp4');
      await trimVideo(source, edited, row.editStartMs / 1000, (row.editEndMs - row.editStartMs) / 1000);
      const newKey = `${dir}/${id}/edited-${randomToken(6)}.mp4`;
      await objectStorage.uploadFile(newKey, edited, 'video/mp4');
      const size = (await fs.stat(edited)).size;
      await content.update({ where: { id }, data: { videoKey: newKey, mimeType: 'video/mp4', sizeBytes: size, editStartMs: null, editEndMs: null } });
      try { await objectStorage.delete(row.videoKey); } catch (e) { console.warn('[stockage] source non supprimée après découpage :', (e as Error).message); }
      current = edited;
    }

    const thumbnail = path.join(work, 'thumbnail.jpg');
    if (!row.thumbnailKey) {
      const key = `${dir}/${id}/thumbnail.jpg`;
      await generateThumbnail(current, thumbnail, (row.coverMs ?? 1000) / 1000);
      await objectStorage.uploadFile(key, thumbnail, 'image/jpeg');
      await content.update({ where: { id }, data: { thumbnailKey: key } });
    }

    // Lot 3 : on efface d'abord les anciennes playlists et segments de ce contenu (ils ne doivent pas rester publics).
    await objectStorage.deletePrefix(`${dir}/${id}/hls/`);
    if (restricted) {
      // Aucune version publique : on supprime les anciennes variantes et on marque le contenu prêt (lecture par URL signée).
      await prisma.$transaction(async (tx) => {
        if (kind === 'VIDEO') {
          await tx.videoVariant.deleteMany({ where: { videoId: id } });
          await tx.video.update({ where: { id }, data: { processingStatus: 'READY', processedAt: new Date(), processingError: null, manifestKey: null } });
        } else {
          await tx.videoVariant.deleteMany({ where: { shortId: id } });
          await tx.short.update({ where: { id }, data: { processingStatus: 'READY', processedAt: new Date(), processingError: null, manifestKey: null } });
        }
      });
      return;
    }

    const out = await transcodeToHls(current, row.width, row.height);
    const prefix = `${dir}/${id}/hls`;
    for (const r of out.renditions) for (const f of await listFiles(r.file)) await objectStorage.uploadFile(`${prefix}/${f}`, path.join(r.file, f), mime(f));
    const masterPath = path.join(out.dir, 'master.m3u8');
    await fs.writeFile(masterPath, out.master);
    const masterKey = `${prefix}/master.m3u8`;
    await objectStorage.uploadFile(masterKey, masterPath, 'application/vnd.apple.mpegurl');
    await prisma.$transaction(async (tx) => {
      if (kind === 'VIDEO') {
        await tx.videoVariant.deleteMany({ where: { videoId: id } });
        for (const r of out.renditions) await tx.videoVariant.create({ data: { contentId: id, height: r.height, width: r.width, bitrateKbps: r.bitrateKbps, objectKey: `${prefix}/${r.height}/index.m3u8`, videoId: id } });
        await tx.video.update({ where: { id }, data: { processingStatus: 'READY', processedAt: new Date(), processingError: null, manifestKey: masterKey } });
      } else {
        await tx.videoVariant.deleteMany({ where: { shortId: id } });
        for (const r of out.renditions) await tx.videoVariant.create({ data: { contentId: id, height: r.height, width: r.width, bitrateKbps: r.bitrateKbps, objectKey: `${prefix}/${r.height}/index.m3u8`, shortId: id } });
        await tx.short.update({ where: { id }, data: { processingStatus: 'READY', processedAt: new Date(), processingError: null, manifestKey: masterKey } });
      }
    });
  } catch (e) {
    await content.update({ where: { id }, data: { processingStatus: 'FAILED', processingError: String((e as Error).message).slice(0, 1000) } }).catch(() => undefined);
    throw e;
  } finally {
    await cleanupTranscodeDir(work);
  }
}
