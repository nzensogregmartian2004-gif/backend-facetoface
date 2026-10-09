import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { objectStorage } from '../src/utils/objectStorage';
import { purgeExpiredMessages } from '../src/modules/messages/disappearing.sweeper';
import { api, creatorSignedIn, memStore, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';
const G = '/api/groups';
const DAY = 86_400_000;
const PAY = { operator: 'AIRTEL_MONEY', phone: '060 12 34 56' };

const open = (a: S, b: S) => api().post(`${M}/conversations`).set(a.auth).send({ userId: b.user.id });
const convId = async (a: S, b: S) => (await open(a, b)).body.conversation.id as string;
const send = (a: S, cid: string, body: Record<string, unknown>) => api().post(`${M}/conversations/${cid}/messages`).set(a.auth).send(body);
const say = async (a: S, cid: string, text = 'salut') => (await send(a, cid, { text })).body.message as { id: string };
const listed = async (a: S, cid: string) => (await api().get(`${M}/conversations/${cid}/messages`).set(a.auth)).body.items as any[];
const setTimer = (a: S, cid: string, seconds: number) => api().post(`${M}/conversations/${cid}/disappearing`).set(a.auth).send({ seconds });
const conv = async (a: S, cid: string) => (await api().get(`${M}/conversations/${cid}`).set(a.auth)).body.conversation;
const inboxItem = async (a: S, cid: string) => ((await api().get(`${M}/conversations`).set(a.auth)).body.items as any[]).find((i) => i.id === cid);
const expiresOf = async (id: string) => (await prisma.message.findUniqueOrThrow({ where: { id } })).expiresAt;
const expireNow = (id: string) => prisma.message.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });

async function mediaKey(a: S, cid: string, contentType = 'image/png', size = 50_000) {
  const r = await api().post(`${M}/upload-url`).set(a.auth).send({ conversationId: cid, contentType, sizeBytes: size });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  memStore.put(r.body.upload.key, size, contentType);
  return r.body.upload.key as string;
}
async function groupOf(owner: S, others: S[]) {
  const r = await api().post(G).set(owner.auth).send({ name: 'Équipe', memberIds: others.map((o) => o.user.id) });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.group.id as string;
}

describe('messages éphémères par conversation', () => {
  it('réglage par conversation : visible des deux côtés ; les messages suivants sont datés', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    expect((await conv(a, cid)).disappearingSeconds).toBe(0);
    const r = await setTimer(a, cid, 7 * 86_400);
    expect(r.status).toBe(200);
    expect(r.body.seconds).toBe(7 * 86_400);
    expect((await conv(b, cid)).disappearingSeconds).toBe(7 * 86_400);
    const m = await say(a, cid);
    const exp = await expiresOf(m.id);
    expect(exp).not.toBeNull();
    expect(Math.abs((exp!.getTime() - Date.now()) - 7 * DAY)).toBeLessThan(60_000);
  });

  it('valeurs acceptées : désactivé, ou un nombre entier de jours de 1 à 365 ; le reste est refusé', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    for (const bad of [3_600, 86_401, 129_600, 366 * 86_400, -86_400]) expect((await setTimer(a, cid, bad)).status).toBe(400);
    for (const ok of [0, 86_400, 30 * 86_400, 365 * 86_400]) expect((await setTimer(a, cid, ok)).status).toBe(200);
  });

  it('groupe : seuls les administrateurs règlent ; les membres voient le réglage', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupOf(a, [b, c]);
    const denied = await setTimer(b, gid, 86_400);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('GROUP_ADMIN_REQUIRED');
    expect((await setTimer(a, gid, 7 * 86_400)).status).toBe(200);
    expect((await conv(c, gid)).disappearingSeconds).toBe(7 * 86_400);
  });

  it('un message ne suit que le réglage en vigueur au moment de son envoi', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const before = await say(a, cid);
    await setTimer(a, cid, 86_400);
    const after = await say(a, cid);
    await setTimer(a, cid, 0);
    const off = await say(a, cid);
    expect(await expiresOf(before.id)).toBeNull();
    expect(await expiresOf(after.id)).not.toBeNull();
    expect(await expiresOf(off.id)).toBeNull();
  });

  it('à l’échéance : masqué aussitôt, contenu supprimé à la purge, aperçu et recherche vidés', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const keep = await say(a, cid, 'message permanent');
    await setTimer(a, cid, 86_400);
    const gone = await say(a, cid, 'secret éphémère');
    await expireNow(gone.id);
    expect((await listed(b, cid)).find((m) => m.id === gone.id)).toBeUndefined();
    expect((await inboxItem(b, cid)).lastMessage).toBeNull();

    expect(await purgeExpiredMessages(new Date(Date.now() + 2 * DAY))).toBe(1);
    const row = await prisma.message.findUniqueOrThrow({ where: { id: gone.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.text).toBeNull();
    expect((await inboxItem(b, cid)).lastMessage.text).toBe('message permanent');
    expect((await listed(b, cid)).map((m) => m.id)).toContain(keep.id);
    const hit = await api().post(`${M}/conversations/${cid}/search`).set(b.auth).send({ q: 'éphémère' });
    expect(hit.body.items).toEqual([]);
  });

  it('média éphémère : le fichier est supprimé à l’échéance', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await setTimer(a, cid, 86_400);
    const key = await mediaKey(a, cid);
    const r = await send(a, cid, { mediaKey: key });
    expect(r.status).toBe(201);
    expect(await purgeExpiredMessages(new Date(Date.now() + 2 * DAY))).toBe(1);
    expect(await objectStorage.head(key)).toBeNull();
    expect((await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } })).mediaKey).toBeNull();
  });

  it('un message expiré ne compte plus dans les non-lus', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await setTimer(a, cid, 86_400);
    await say(a, cid);
    expect((await conv(b, cid)).unreadCount).toBe(1);
    await purgeExpiredMessages(new Date(Date.now() + 2 * DAY));
    expect((await conv(b, cid)).unreadCount).toBe(0);
  });

  it('achat payant : le message expire, l’achat reste enregistré (traçabilité)', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    await setTimer(creator, cid, 86_400);
    const sent = await send(creator, cid, { text: 'exclusif', price: 1000 });
    expect(sent.status).toBe(201);
    const id = sent.body.message.id as string;
    const u = await api().post(`${M}/${id}/unlock`).set(fan.auth).send(PAY);
    expect(u.status).toBe(202);
    const ref = (await prisma.messagePurchase.findFirstOrThrow({ where: { id: u.body.purchase.id } })).reference!;
    expect((await settle(ref, 'SUCCESS', { amount: 1000 })).status).toBe(200);
    await expireNow(id);
    await purgeExpiredMessages(new Date(Date.now() + 2 * DAY));
    expect(await prisma.messagePurchase.count({ where: { status: 'PAID' } })).toBe(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    expect((await listed(fan, cid)).find((m) => m.id === id)).toBeUndefined();
  });

  it('transfert : la copie suit le réglage de la conversation de destination', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const other = await convId(a, c);
    const m = await say(a, cid);
    await setTimer(a, other, 86_400);
    const fwd = await api().post(`${M}/messages/${m.id}/forward`).set(a.auth).send({ targetConversationId: other });
    expect(fwd.status).toBe(200);
    expect(await expiresOf(fwd.body.message.id)).not.toBeNull();
  });

  it('fichier partagé par transfert : supprimé seulement quand plus aucun message ne le référence', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const other = await convId(a, c);
    const key = await mediaKey(a, cid);
    const original = (await send(a, cid, { mediaKey: key })).body.message.id as string;
    await setTimer(a, other, 86_400);
    const copy = (await api().post(`${M}/messages/${original}/forward`).set(a.auth).send({ targetConversationId: other })).body.message.id as string;
    await expireNow(copy);
    expect(await purgeExpiredMessages()).toBe(1);
    expect(await objectStorage.head(key)).not.toBeNull(); // l'original le référence encore
    await expireNow(original);
    expect(await purgeExpiredMessages()).toBe(1);
    expect(await objectStorage.head(key)).toBeNull();
  });
});
