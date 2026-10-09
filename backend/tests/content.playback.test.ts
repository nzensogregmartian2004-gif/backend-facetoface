import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

/** Vidéo publiée, prête à être lue, à prix donné. */
async function publishedVideo(authorId: string, price: number | null) {
  return prisma.video.create({
    data: {
      authorId, title: 'Vidéo test', category: 'Autres', status: 'PUBLISHED', visibility: 'PUBLIC', processingStatus: 'READY',
      videoKey: `videos/${authorId}.mp4`, uploadedAt: new Date(), durationSeconds: 30, mimeType: 'video/mp4',
      publishedAt: new Date(), price, currency: price != null ? 'XAF' : null,
    },
  });
}

describe('étape 10 — lecture des vidéos payantes', () => {
  it('sans achat : refus, aucune URL', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const video = await publishedVideo(author.user.id, 1000);
    const r = await api().get(`/api/videos/${video.id}/playback`).set(fan.auth);
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
  });

  it('après achat : URL signée de courte durée, mode privé, pas d’adaptatif', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const video = await publishedVideo(author.user.id, 1000);
    await prisma.paidContentPurchase.create({
      data: { contentType: 'VIDEO', contentId: video.id, buyerId: fan.user.id, creatorId: author.user.id, grossAmount: 1000, commissionAmount: 200, creatorAmount: 800, currency: 'XAF', commissionBps: 2000, status: 'PAID', paidAt: new Date() },
    });
    const r = await api().get(`/api/videos/${video.id}/playback`).set(fan.auth);
    expect(r.status).toBe(200);
    expect(r.body.playback.mode).toBe('PROGRESSIVE_PRIVATE');
    expect(r.body.variants).toEqual([]);
    const seconds = (new Date(r.body.playback.expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeLessThanOrEqual(310);
  });

  it('achat non confirmé (en vérification) : aucun accès, tant que le statut n’est pas PAID', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const video = await publishedVideo(author.user.id, 1000);
    await prisma.paidContentPurchase.create({
      data: { contentType: 'VIDEO', contentId: video.id, buyerId: fan.user.id, creatorId: author.user.id, grossAmount: 1000, commissionAmount: 200, creatorAmount: 800, currency: 'XAF', commissionBps: 2000, status: 'REVIEW', paidAt: new Date() },
    });
    expect((await api().get(`/api/videos/${video.id}/playback`).set(fan.auth)).status).toBe(403);
  });
});
