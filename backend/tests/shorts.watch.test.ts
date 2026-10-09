import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

/** Short publié, lisible, gratuit. */
async function publishedShort(authorId: string) {
  return prisma.short.create({
    data: {
      authorId, title: 'Short test', category: 'Autres', status: 'PUBLISHED', visibility: 'PUBLIC', processingStatus: 'READY',
      videoKey: `shorts/${authorId}.mp4`, uploadedAt: new Date(), durationSeconds: 20, width: 720, height: 1280,
      mimeType: 'video/mp4', publishedAt: new Date(),
    },
  });
}

describe('étape 11 — temps de visionnage des Shorts (non exécuté ici : base requise)', () => {
  it('un spectateur envoie un lot : accepté ; le même lot rejoué ne compte pas deux fois', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const short = await publishedShort(author.user.id);
    const batch = { sessions: [{ clientSessionId: 'session-0001', watchedMs: 12_000, completed: false }] };
    expect((await api().post(`/api/shorts/${short.id}/watch`).set(fan.auth).send(batch)).body.accepted).toBe(1);
    expect((await api().post(`/api/shorts/${short.id}/watch`).set(fan.auth).send(batch)).body.accepted).toBe(0);
    expect(await prisma.shortWatchEvent.count({ where: { shortId: short.id } })).toBe(1);
  });

  it('un instantané puis le total final : une seule session, le plus grand temps gagne', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const short = await publishedShort(author.user.id);
    await api().post(`/api/shorts/${short.id}/watch`).set(fan.auth).send({ sessions: [{ clientSessionId: 'session-0002', watchedMs: 5_000, completed: false }] });
    await api().post(`/api/shorts/${short.id}/watch`).set(fan.auth).send({ sessions: [{ clientSessionId: 'session-0002', watchedMs: 20_000, completed: true }] });
    const row = await prisma.shortWatchEvent.findFirst({ where: { shortId: short.id } });
    expect(row?.watchedMs).toBe(20_000);
    expect(row?.completed).toBe(true);
  });

  it('l\'auteur ne compte pas ses propres lectures', async () => {
    const author = await creatorSignedIn(1);
    const short = await publishedShort(author.user.id);
    const r = await api().post(`/api/shorts/${short.id}/watch`).set(author.auth).send({ sessions: [{ clientSessionId: 'session-0003', watchedMs: 9_000, completed: false }] });
    expect(r.body.accepted).toBe(0);
  });

  it('la rétention du créateur ne contient aucun identifiant de spectateur', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const short = await publishedShort(author.user.id);
    await api().post(`/api/shorts/${short.id}/watch`).set(fan.auth).send({ sessions: [{ clientSessionId: 'session-0004', watchedMs: 10_000, completed: false }] });
    const r = await api().get('/api/shorts/stats/retention?range=30d').set(author.auth);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain(fan.user.id);
  });
});
