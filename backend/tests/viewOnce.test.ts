import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { objectStorage } from '../src/utils/objectStorage';
import { purgeViewOnceMedia } from '../src/modules/messages/viewOnce.sweeper';
import { api, creatorSignedIn, memStore, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';
const G = '/api/groups';
const DAY = 86_400_000;
const MIN = 60_000;
const PAY = { operator: 'AIRTEL_MONEY', phone: '060 12 34 56' };

const open = (a: S, b: S) => api().post(`${M}/conversations`).set(a.auth).send({ userId: b.user.id });
const convId = async (a: S, b: S) => (await open(a, b)).body.conversation.id as string;
const send = (a: S, cid: string, body: Record<string, unknown>) => api().post(`${M}/conversations/${cid}/messages`).set(a.auth).send(body);
const listed = async (a: S, cid: string) => (await api().get(`${M}/conversations/${cid}/messages`).set(a.auth)).body.items as any[];
const openMsg = (a: S, id: string) => api().post(`${M}/messages/${id}/open`).set(a.auth).send({});

/** Envoi simulé d'une photo : URL signée → « PUT » direct → clé prête pour le message. */
async function mediaKey(a: S, cid: string, contentType = 'image/png', size = 50_000) {
  const r = await api().post(`${M}/upload-url`).set(a.auth).send({ conversationId: cid, contentType, sizeBytes: size });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  memStore.put(r.body.upload.key, size, contentType);
  return r.body.upload.key as string;
}
/** Envoi d'une photo à vue unique dans une conversation. */
async function viewOnceMedia(a: S, cid: string, extra: Record<string, unknown> = {}) {
  const key = await mediaKey(a, cid);
  const r = await send(a, cid, { mediaKey: key, viewOnce: true, ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { id: r.body.message.id as string, key };
}
async function groupOf(owner: S, others: S[]) {
  const r = await api().post(G).set(owner.auth).send({ name: 'Équipe', memberIds: others.map((o) => o.user.id) });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.group.id as string;
}

describe('photos et vidéos à vue unique', () => {
  it('ne concerne que les médias : texte refusé, envoi sans média refusé', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const textOnly = await send(a, cid, { text: 'bonjour', viewOnce: true });
    expect(textOnly.status).toBe(400);
    expect(textOnly.body.error.code).toBe('VIEW_ONCE_MEDIA_ONLY');
    const withText = await send(a, cid, { text: 'légende', mediaKey: await mediaKey(a, cid), viewOnce: true });
    expect(withText.status).toBe(400);
    expect(withText.body.error.code).toBe('VIEW_ONCE_NO_TEXT');
    expect((await send(a, cid, { viewOnce: true })).status).toBe(400);
  });

  it('ne révèle ni média, ni type, ni aperçu avant ouverture ; l’expéditeur voit seulement l’état', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const { id, key } = await viewOnceMedia(a, cid);

    const recv = (await listed(b, cid)).find((m) => m.id === id);
    expect(recv).toMatchObject({ text: null, kind: null, media: null, viewOnce: { role: 'RECIPIENT', state: 'AVAILABLE', openedAt: null } });
    expect(JSON.stringify(recv)).not.toContain(key);

    const inbox = (await api().get(`${M}/conversations`).set(b.auth)).body.items[0];
    expect(inbox.lastMessage.text).toBe('👁 Message à vue unique');

    const hit = await api().post(`${M}/conversations/${cid}/search`).set(b.auth).send({ q: 'a' });
    expect(hit.body.items.find((m: any) => m.id === id)).toBeUndefined();

    const mine = (await listed(a, cid)).find((m) => m.id === id);
    expect(mine).toMatchObject({ media: null, kind: null, viewOnce: { role: 'SENDER', total: 1, openedCount: 0 } });
    expect(mine.viewOnce.openings).toEqual([{ userId: b.user.id, displayName: expect.any(String), openedAt: null }]);
  });

  it('ouverture unique : le destinataire obtient la photo une fois ; ensuite 410 et plus rien ; l’expéditeur voit l’heure d’ouverture', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const { id } = await viewOnceMedia(a, cid);

    const first = await openMsg(b, id);
    expect(first.status).toBe(200);
    expect(first.body.message).toMatchObject({ mine: false, kind: 'MEDIA', text: null, media: { type: 'IMAGE' }, viewOnce: { role: 'RECIPIENT', state: 'OPENED' } });
    expect(first.body.message.media.url).toBeTruthy();

    const second = await openMsg(b, id);
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('VIEW_ONCE_CONSUMED');

    const after = (await listed(b, cid)).find((m) => m.id === id);
    expect(after).toMatchObject({ media: null, viewOnce: { role: 'RECIPIENT', state: 'OPENED' } });
    expect(after.viewOnce.openedAt).toBeTruthy();

    const sender = (await listed(a, cid)).find((m) => m.id === id);
    expect(sender.viewOnce).toMatchObject({ role: 'SENDER', total: 1, openedCount: 1 });
    expect(sender.viewOnce.openings[0].openedAt).toBeTruthy();
  });

  it('deux ouvertures simultanées ne servent la photo qu’une seule fois', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const { id } = await viewOnceMedia(a, cid);
    const [r1, r2] = await Promise.all([openMsg(b, id), openMsg(b, id)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 410]);
  });

  it('l’expéditeur ne peut pas ouvrir son message (403) ; un tiers ne le voit pas (404)', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const { id } = await viewOnceMedia(a, cid);
    const own = await openMsg(a, id);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('VIEW_ONCE_SENDER');
    expect((await openMsg(c, id)).status).toBe(404);
  });

  it('groupe : chaque membre ouvre une fois, indépendamment ; l’expéditeur voit qui a ouvert ; un membre arrivé après l’envoi ne peut pas', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3); const d = await signedIn(4);
    const gid = await groupOf(a, [b, c]);
    const { id } = await viewOnceMedia(a, gid);

    expect((await openMsg(b, id)).status).toBe(200);
    expect((await openMsg(b, id)).status).toBe(410);
    // c n'a pas encore ouvert : sa vue reste disponible.
    expect((await listed(c, gid)).find((m) => m.id === id).viewOnce).toMatchObject({ role: 'RECIPIENT', state: 'AVAILABLE' });
    expect((await openMsg(c, id)).status).toBe(200);

    // d rejoint le groupe après l'envoi : pas destinataire de ce message.
    await api().post(`${G}/${gid}/members`).set(a.auth).send({ userIds: [d.user.id] });
    expect((await openMsg(d, id)).status).toBe(404);
    expect((await listed(d, gid)).find((m) => m.id === id).viewOnce).toMatchObject({ role: 'RECIPIENT', state: 'UNAVAILABLE' });

    const sender = (await listed(a, gid)).find((m) => m.id === id);
    expect(sender.viewOnce).toMatchObject({ role: 'SENDER', total: 2, openedCount: 2 });
  });

  it('un membre qui quitte le groupe avant d’ouvrir n’est plus destinataire (la photo n’attend plus sa réponse)', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupOf(a, [b, c]);
    const { id } = await viewOnceMedia(a, gid);
    await api().post(`${G}/${gid}/leave`).set(c.auth).send({});
    expect(await prisma.viewOnceRecipient.count({ where: { messageId: id, userId: c.user.id } })).toBe(0);
    const sender = (await listed(a, gid)).find((m) => m.id === id);
    expect(sender.viewOnce.total).toBe(1);
  });

  it('transfert, édition et export ne laissent jamais sortir le contenu', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const { id } = await viewOnceMedia(a, cid);
    const exp = await api().get(`${M}/conversations/${cid}/export`).set(a.auth);
    const exported = exp.body.messages.find((m: any) => m.id === id);
    expect(exported.text).toBeNull();
    const bc = await convId(b, c);
    const fwd = await api().post(`${M}/messages/${id}/forward`).set(b.auth).send({ targetConversationId: bc });
    expect(fwd.status).toBe(403);
    expect(fwd.body.error.code).toBe('VIEW_ONCE_NOT_FORWARDABLE');
    const edit = await api().post(`${M}/messages/${id}/edit`).set(a.auth).send({ text: 'modifié' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('VIEW_ONCE_IMMUTABLE');
  });

  it('un message à vue unique n’a pas de délai de disparition, même si la conversation en a un', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    expect((await api().post(`${M}/conversations/${cid}/disappearing`).set(a.auth).send({ seconds: 86400 })).status).toBe(200);
    const { id } = await viewOnceMedia(a, cid);
    expect((await prisma.message.findUniqueOrThrow({ where: { id } })).expiresAt).toBeNull();
    // Un message ordinaire, lui, suit toujours le réglage de la conversation.
    const plain = await send(a, cid, { text: 'normal' });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: plain.body.message.id } })).expiresAt).not.toBeNull();
  });

  it('désactivable par configuration : refusé à l’envoi, signalé dans les réglages ; une photo ordinaire reste possible', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    expect((await api().get(`${M}/settings`).set(a.auth)).body.viewOnce.enabled).toBe(true);
    await prisma.appConfig.upsert({ where: { key: 'MESSAGING.VIEW_ONCE_ENABLED' }, update: { value: false, enabled: true }, create: { key: 'MESSAGING.VIEW_ONCE_ENABLED', value: false, type: 'BOOLEAN', enabled: true, description: 'test', defaultValue: true, category: 'GENERAL' } });
    expect((await api().get(`${M}/settings`).set(a.auth)).body.viewOnce.enabled).toBe(false);
    const key = await mediaKey(a, cid);
    const r = await send(a, cid, { mediaKey: key, viewOnce: true });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('VIEW_ONCE_DISABLED');
    expect((await send(a, cid, { mediaKey: await mediaKey(a, cid) })).status).toBe(201);
  });

  it('purge : le fichier disparaît dès que tous ont ouvert, après le délai technique ; le message reste « ouvert »', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const { id, key } = await viewOnceMedia(a, cid);
    // Non ouvert : jamais purgé, même très tard (aucune expiration automatique).
    expect(await purgeViewOnceMedia(new Date(Date.now() + 400 * DAY))).toBe(0);
    expect(await objectStorage.head(key)).not.toBeNull();

    expect((await openMsg(b, id)).status).toBe(200);
    // Ouvert il y a moins que le délai technique : le fichier reste le temps de charger l'URL remise.
    expect(await purgeViewOnceMedia(new Date(Date.now() + MIN))).toBe(0);
    expect(await objectStorage.head(key)).not.toBeNull();
    // Délai dépassé : fichier supprimé, le message subsiste « ouvert ».
    expect(await purgeViewOnceMedia(new Date(Date.now() + 10 * MIN))).toBe(1);
    expect(await objectStorage.head(key)).toBeNull();
    expect((await prisma.message.findUniqueOrThrow({ where: { id } })).mediaKey).toBeNull();
    const after = (await listed(b, cid)).find((m) => m.id === id);
    expect(after).toMatchObject({ media: null, viewOnce: { state: 'OPENED', role: 'RECIPIENT' } });
    expect(after.viewOnce.openedAt).toBeTruthy();
  });

  it('groupe : tant qu’un destinataire n’a pas ouvert, le fichier reste', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupOf(a, [b, c]);
    const { id, key } = await viewOnceMedia(a, gid);
    expect((await openMsg(b, id)).status).toBe(200);
    expect(await purgeViewOnceMedia(new Date(Date.now() + 400 * DAY))).toBe(0);
    expect(await objectStorage.head(key)).not.toBeNull();
    expect((await openMsg(c, id)).status).toBe(200);
    expect(await purgeViewOnceMedia(new Date(Date.now() + 10 * MIN))).toBe(1);
  });

  it('aucun signalement sur une vue unique ; un message ordinaire reste signalable', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const { id } = await viewOnceMedia(a, cid);
    await openMsg(b, id);
    const report = await api().post('/api/moderation/reports').set(b.auth).send({ targetType: 'MESSAGE', targetId: id, reason: 'OTHER' });
    expect(report.status).toBe(403);
    expect(report.body.error.code).toBe('VIEW_ONCE_NOT_REPORTABLE');
    const plain = await send(a, cid, { text: 'message ordinaire' });
    const ok = await api().post('/api/moderation/reports').set(b.auth).send({ targetType: 'MESSAGE', targetId: plain.body.message.id, reason: 'SPAM' });
    expect(ok.status).toBeLessThan(300);
  });

  it('vocal en vue unique : enregistré, ouvert une fois, durée conservée', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const key = await mediaKey(a, cid, 'audio/mp4', 40_000);
    const sent = await send(a, cid, { mediaKey: key, viewOnce: true, durationMs: 12_345 });
    expect(sent.status).toBe(201);
    const id = sent.body.message.id as string;
    expect(sent.body.message).toMatchObject({ kind: null, media: null, viewOnce: { role: 'SENDER', total: 1, openedCount: 0 } });
    const opened = await openMsg(b, id);
    expect(opened.status).toBe(200);
    expect(opened.body.message.media).toMatchObject({ type: 'AUDIO', durationMs: 12_345, mimeType: 'audio/mp4' });
    expect((await openMsg(b, id)).status).toBe(410);
  });

  it('vocal ordinaire : lisible par le destinataire avec sa durée, pas de vue unique', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const key = await mediaKey(a, cid, 'audio/mp4', 40_000);
    const sent = await send(a, cid, { mediaKey: key, durationMs: 4_000 });
    expect(sent.status).toBe(201);
    const recv = (await listed(b, cid)).find((m) => m.id === sent.body.message.id);
    expect(recv).toMatchObject({ kind: 'MEDIA', viewOnce: null, media: { type: 'AUDIO', durationMs: 4_000 } });
  });

  it('vue unique payante : verrouillée tant que l’achat n’est pas réglé, puis ouverte une seule fois', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    const { id } = await viewOnceMedia(creator, cid, { price: 1000 });
    const locked = await openMsg(fan, id);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('MESSAGE_LOCKED');

    const u = await api().post(`${M}/${id}/unlock`).set(fan.auth).send(PAY);
    expect(u.status).toBe(202);
    const ref = (await prisma.messagePurchase.findFirstOrThrow({ where: { id: u.body.purchase.id } })).reference!;
    expect((await settle(ref, 'SUCCESS', { amount: 1000 })).status).toBe(200);

    const ok = await openMsg(fan, id);
    expect(ok.status).toBe(200);
    expect(ok.body.message.media).toBeTruthy();
    expect((await openMsg(fan, id)).status).toBe(410);
  });
});
