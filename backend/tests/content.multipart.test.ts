import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { objectStorage, MemoryStorage } from '../src/utils/objectStorage';
import { MIB } from '../src/modules/content/multipart.policy';
import { api, creatorSignedIn, resetDb } from './helpers';

beforeEach(resetDb);
const memory = () => objectStorage as unknown as MemoryStorage;

describe('étape 10 lot 3 — envoi par parties (non exécuté ici : base requise)', () => {
  it('début, parties, finalisation : le fichier est assemblé et la taille vérifiée', async () => {
    const author = await creatorSignedIn(1);
    const draft = await api().post('/api/videos').set(author.auth).send({ title: 'Long', category: 'music' });
    const id = draft.body.video.id;
    const size = 12 * MIB;
    const start = await api().post(`/api/videos/${id}/multipart/start`).set(author.auth).send({ sizeBytes: size, contentType: 'video/mp4' });
    expect(start.status).toBe(200);
    expect(start.body.partCount).toBe(2);
    memory().addPart(start.body.uploadId, 1, 8 * MIB);
    memory().addPart(start.body.uploadId, 2, 4 * MIB);
    const done = await api().post(`/api/videos/${id}/multipart/complete`).set(author.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.sizeBytes).toBe(size);
  });

  it('finalisation avec une partie manquante : refusée (409), la session reste reprenable', async () => {
    const author = await creatorSignedIn(1);
    const id = (await api().post('/api/videos').set(author.auth).send({ title: 'Long', category: 'music' })).body.video.id;
    const start = await api().post(`/api/videos/${id}/multipart/start`).set(author.auth).send({ sizeBytes: 12 * MIB, contentType: 'video/mp4' });
    memory().addPart(start.body.uploadId, 1, 8 * MIB);
    const r = await api().post(`/api/videos/${id}/multipart/complete`).set(author.auth).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PARTS_MISSING');
    const status = await api().get(`/api/videos/${id}/multipart`).set(author.auth);
    expect(status.body.session.uploaded).toEqual([1]);
  });

  it('verrouiller une vidéo publique : sa playlist est purgée, puis le verrouillage est appliqué', async () => {
    const author = await creatorSignedIn(1);
    const video = await prisma.video.create({
      data: {
        authorId: author.user.id, title: 'Gratuite', category: 'music', status: 'PUBLISHED', visibility: 'PUBLIC', processingStatus: 'READY',
        videoKey: `videos/${author.user.id}/source.mp4`, uploadedAt: new Date(), durationSeconds: 30, width: 1280, height: 720,
        mimeType: 'video/mp4', publishedAt: new Date(), manifestKey: 'videos/x/hls/master.m3u8',
      },
    });
    memory().put(`videos/${video.id}/hls/master.m3u8`, 10, 'application/vnd.apple.mpegurl');
    memory().put(`videos/${video.id}/hls/720/00000.ts`, 1000, 'video/mp2t');
    const r = await api().patch(`/api/videos/${video.id}`).set(author.auth).send({ price: 1000, currency: 'XAF' });
    expect(r.status).toBe(200);
    expect(await memory().listKeys(`videos/${video.id}/hls/`)).toEqual([]);
    expect((await prisma.video.findUnique({ where: { id: video.id } }))?.manifestKey).toBeNull();
  });
});
