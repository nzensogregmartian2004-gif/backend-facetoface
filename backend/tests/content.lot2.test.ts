import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

/** Vidéo publiée et lisible, avec playlist HLS publique (cas d'un contenu gratuit déjà transcodé). */
async function transcodedFreeVideo(authorId: string) {
  return prisma.video.create({
    data: {
      authorId, title: 'Vidéo test', category: 'Autres', status: 'PUBLISHED', visibility: 'PUBLIC', processingStatus: 'READY',
      videoKey: `videos/${authorId}/source.mp4`, uploadedAt: new Date(), durationSeconds: 30, width: 1280, height: 720,
      mimeType: 'video/mp4', publishedAt: new Date(), manifestKey: 'videos/x/hls/master.m3u8',
    },
  });
}

describe('étape 10 lot 2 — verrouillage et nouvel essai', () => {
  it('passer une vidéo HLS publique en payante supprime sa playlist publique (non exécuté ici)', async () => {
    const author = await creatorSignedIn(1);
    const video = await transcodedFreeVideo(author.user.id);
    const r = await api().patch(`/api/videos/${video.id}`).set(author.auth).send({ price: 1000, currency: 'XAF' });
    expect(r.status).toBe(200);
    const after = await prisma.video.findUnique({ where: { id: video.id } });
    expect(after?.manifestKey).toBeNull();
  });

  it('nouvel essai refusé à un autre utilisateur (404, non exécuté ici)', async () => {
    const author = await creatorSignedIn(1); const other = await signedIn(2);
    const video = await transcodedFreeVideo(author.user.id);
    const r = await api().post(`/api/videos/${video.id}/retry-processing`).set(other.auth).send({});
    expect(r.status).toBe(404);
  });

  it('nouvel essai sur un contenu déjà prêt : renvoyé tel quel (non exécuté ici)', async () => {
    const author = await creatorSignedIn(1);
    const video = await transcodedFreeVideo(author.user.id);
    const r = await api().post(`/api/videos/${video.id}/retry-processing`).set(author.auth).send({});
    expect(r.status).toBe(200);
    expect(r.body.video.processingStatus).toBe('READY');
  });
});
