import { beforeEach, describe, expect, it } from 'vitest';
import { api, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';

const open = (a: S, b: S) => api().post(`${M}/conversations`).set(a.auth).send({ userId: b.user.id });
const convId = async (a: S, b: S) => (await open(a, b)).body.conversation.id as string;
const say = async (a: S, cid: string, text = 'salut') => (await api().post(`${M}/conversations/${cid}/messages`).set(a.auth).send({ text })).body.message as { id: string };
const messagesOf = (a: S, cid: string) => api().get(`${M}/conversations/${cid}/messages`).set(a.auth);
const statusOf = async (a: S, cid: string, id: string) => ((await messagesOf(a, cid)).body.items as any[]).find((m) => m.id === id)?.status;
const markRead = (a: S, cid: string) => api().post(`${M}/conversations/${cid}/read`).set(a.auth).send({});
const inbox = async (a: S, q = '') => ((await api().get(`${M}/conversations${q}`).set(a.auth)).body.items as any[]);

describe('coches, présence, archivage, favoris', () => {
  it('coches : envoyé, puis reçu quand le destinataire charge la conversation, puis lu quand il l’ouvre', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m = await say(a, cid);
    expect(await statusOf(a, cid, m.id)).toBe('SENT');
    await messagesOf(b, cid);
    expect(await statusOf(a, cid, m.id)).toBe('DELIVERED');
    await markRead(b, cid);
    expect(await statusOf(a, cid, m.id)).toBe('READ');
  });

  it('pas de coche bleue si le destinataire a désactivé les accusés de lecture', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m = await say(a, cid);
    expect((await api().patch('/api/users/me/privacy').set(b.auth).send({ showReadReceipts: false })).status).toBe(200);
    await messagesOf(b, cid);
    await markRead(b, cid);
    expect(await statusOf(a, cid, m.id)).toBe('DELIVERED');
  });

  it('présence : hors ligne et sans dernière connexion par défaut ; masquée si le destinataire désactive le statut', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await say(a, cid);
    const c1 = (await api().get(`${M}/conversations/${cid}`).set(a.auth)).body.conversation;
    expect(c1.presence).toEqual({ online: false, lastSeenAt: null });
    await api().patch('/api/users/me/privacy').set(b.auth).send({ showOnlineStatus: false });
    const c2 = (await api().get(`${M}/conversations/${cid}`).set(a.auth)).body.conversation;
    expect(c2.presence).toBeNull();
  });

  it('archiver : la conversation quitte la boîte, reste dans « Archivées », et revient avec un nouveau message', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await say(b, cid);
    expect((await inbox(a)).map((i) => i.id)).toContain(cid);
    expect((await api().post(`${M}/conversations/${cid}/archive`).set(a.auth).send({ archived: true })).status).toBe(200);
    expect((await inbox(a)).map((i) => i.id)).not.toContain(cid);
    expect((await inbox(a, '?archived=1')).map((i) => i.id)).toContain(cid);
    await say(b, cid, 'nouveau');
    expect((await inbox(a)).map((i) => i.id)).toContain(cid);
  });

  it('supprimer pour moi : le message disparaît de ma vue seulement', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m = await say(a, cid, 'à retirer');
    expect((await api().post(`${M}/messages/${m.id}/hide-for-me`).set(a.auth).send({})).status).toBe(204);
    expect(((await messagesOf(a, cid)).body.items as any[]).find((x) => x.id === m.id)).toBeUndefined();
    expect(((await messagesOf(b, cid)).body.items as any[]).find((x) => x.id === m.id)).toBeDefined();
    const hit = await api().post(`${M}/conversations/${cid}/search`).set(a.auth).send({ q: 'retirer' });
    expect(hit.body.items).toEqual([]);
  });

  it('favoris : étoile, liste, retrait ; un message supprimé pour moi n’y apparaît plus', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m1 = await say(a, cid, 'un');
    const m2 = await say(a, cid, 'deux');
    expect((await api().post(`${M}/messages/${m1.id}/star`).set(a.auth).send({ starred: true })).status).toBe(200);
    await api().post(`${M}/messages/${m2.id}/star`).set(a.auth).send({ starred: true });
    let list = (await api().get(`${M}/starred`).set(a.auth)).body.items as any[];
    expect(list.map((x) => x.id).sort()).toEqual([m1.id, m2.id].sort());
    expect(list.every((x) => x.starred === true)).toBe(true);
    await api().post(`${M}/messages/${m2.id}/star`).set(a.auth).send({ starred: false });
    list = (await api().get(`${M}/starred`).set(a.auth)).body.items as any[];
    expect(list.map((x) => x.id)).toEqual([m1.id]);
    await api().post(`${M}/messages/${m1.id}/hide-for-me`).set(a.auth).send({});
    list = (await api().get(`${M}/starred`).set(a.auth)).body.items as any[];
    expect(list).toEqual([]);
  });

  it('favori : impossible sur un message auquel on n’a pas accès (404)', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const m = await say(a, cid);
    expect((await api().post(`${M}/messages/${m.id}/star`).set(c.auth).send({ starred: true })).status).toBe(404);
  });
});
