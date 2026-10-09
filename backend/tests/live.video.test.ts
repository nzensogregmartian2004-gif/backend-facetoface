import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

/** Décode la charge utile d'un jeton LiveKit (sans vérifier la signature : on teste les droits décidés). */
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).video;

const e = env as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const set = (k: string, v: unknown) => { saved[k] = e[k]; e[k] = v; };

beforeEach(async () => {
  await resetDb();
  // Serveur LiveKit injoignable : les appels d'administration échouent vite, la décision reste celle de la base.
  set('LIVEKIT_URL', 'ws://127.0.0.1:9'); set('LIVEKIT_API_KEY', 'test-key'); set('LIVEKIT_API_SECRET', 'test-secret-with-32-characters-min!!');
});

async function liveOfCreator() {
  const host = await creatorSignedIn(1);
  const created = await api().post('/api/live').set(host.auth).send({ title: 'Live test', visibility: 'PUBLIC', access: 'EVERYONE' });
  await api().post(`/api/live/${created.body.live.id}/start`).set(host.auth).send({});
  return { host, liveId: created.body.live.id as string };
}

describe('étape 9 — vidéo du Live (serveur)', () => {
  it('l’hôte publie, le spectateur reçoit seulement', async () => {
    const { host, liveId } = await liveOfCreator();
    const viewer = await signedIn(2);
    const h = await api().post(`/api/live/${liveId}/token`).set(host.auth).send({});
    expect(h.status).toBe(200);
    expect(h.body.role).toBe('HOST');
    expect(claims(h.body.token)).toMatchObject({ canPublish: true, room: `live-${liveId}` });
    const v = await api().post(`/api/live/${liveId}/token`).set(viewer.auth).send({});
    expect(v.body.role).toBe('VIEWER');
    expect(claims(v.body.token)).toMatchObject({ canPublish: false, canPublishData: false });
  });

  it('un co-host invité puis accepté publie ; au-delà de trois co-hosts, refus', async () => {
    const { host, liveId } = await liveOfCreator();
    const guests = [await signedIn(10), await signedIn(11), await signedIn(12), await signedIn(13)];
    for (const g of guests.slice(0, 3)) {
      expect((await api().post(`/api/live/${liveId}/cohosts`).set(host.auth).send({ userId: g.user.id })).status).toBe(201);
      expect((await api().post(`/api/live/${liveId}/cohosts/respond`).set(g.auth).send({ accept: true })).status).toBe(200);
    }
    const token = await api().post(`/api/live/${liveId}/token`).set(guests[0].auth).send({});
    expect(token.body.role).toBe('COHOST');
    expect(claims(token.body.token).canPublish).toBe(true);
    const fourth = await api().post(`/api/live/${liveId}/cohosts`).set(host.auth).send({ userId: guests[3].user.id });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('COHOST_LIMIT');
  });

  it('un utilisateur bloqué n’obtient plus de jeton et ne peut plus écrire dans le chat', async () => {
    const { host, liveId } = await liveOfCreator();
    const fan = await signedIn(20);
    expect((await api().post(`/api/live/${liveId}/participants/${fan.user.id}/block`).set(host.auth).send({})).status).toBe(200);
    expect((await api().post(`/api/live/${liveId}/token`).set(fan.auth).send({})).status).toBe(403);
    expect((await api().post(`/api/live/${liveId}/chat`).set(fan.auth).send({ text: 'Bonjour' })).status).toBe(403);
  });

  it('le bilan est réservé à l’hôte et donne la durée et les spectateurs', async () => {
    const { host, liveId } = await liveOfCreator();
    const fan = await signedIn(30);
    expect((await api().get(`/api/live/${liveId}/report`).set(fan.auth)).status).toBe(403);
    const r = await api().get(`/api/live/${liveId}/report`).set(host.auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ currency: 'XAF', followersGained: 0, coHosts: 0 });
    expect(typeof r.body.durationSeconds).toBe('number');
  });

  it('un message supprimé par l’hôte disparaît de la liste du chat', async () => {
    const { host, liveId } = await liveOfCreator();
    const fan = await signedIn(40);
    const sent = await api().post(`/api/live/${liveId}/chat`).set(fan.auth).send({ text: 'Message à retirer' });
    expect(sent.status).toBe(201);
    expect((await api().delete(`/api/live/${liveId}/chat/${sent.body.message.id}`).set(fan.auth)).status).toBe(403);
    expect((await api().delete(`/api/live/${liveId}/chat/${sent.body.message.id}`).set(host.auth)).status).toBe(200);
    const list = await api().get(`/api/live/${liveId}/chat`).set(fan.auth);
    expect(list.body.messages.find((m: { id: string }) => m.id === sent.body.message.id)).toBeUndefined();
    expect(await prisma.liveChatMessage.count({ where: { id: sent.body.message.id, deletedAt: { not: null } } })).toBe(1);
  });

  it('l’hôte liste les co-hosts ; l’invité voit son état, sans accès à la liste', async () => {
    const { host, liveId } = await liveOfCreator();
    const guest = await signedIn(50);
    await api().post(`/api/live/${liveId}/cohosts`).set(host.auth).send({ userId: guest.user.id });
    const list = await api().get(`/api/live/${liveId}/cohosts`).set(host.auth);
    expect(list.status).toBe(200);
    expect(list.body.coHosts[0]).toMatchObject({ userId: guest.user.id, state: 'INVITED' });
    const mine = await api().get(`/api/live/${liveId}/participation`).set(guest.auth);
    expect(mine.body).toMatchObject({ state: 'INVITED', isHost: false });
    expect((await api().get(`/api/live/${liveId}/cohosts`).set(guest.auth)).status).toBe(403);
  });

  it('l’hôte voit les spectateurs présents ; un spectateur ne voit pas cette liste', async () => {
    const { host, liveId } = await liveOfCreator();
    const fan = await signedIn(60);
    expect((await api().post(`/api/live/${liveId}/join`).set(fan.auth).send({})).status).toBe(200);
    const list = await api().get(`/api/live/${liveId}/viewers`).set(host.auth);
    expect(list.status).toBe(200);
    expect(list.body.viewers.map((v: { userId: string }) => v.userId)).toContain(fan.user.id);
    expect((await api().get(`/api/live/${liveId}/viewers`).set(fan.auth)).status).toBe(403);
  });
});
