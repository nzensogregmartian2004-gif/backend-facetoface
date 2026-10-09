import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, memPay, memStore, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';
const open = (a: S, b: S) => api().post(`${M}/conversations`).set(a.auth).send({ userId: b.user.id });
const convId = async (a: S, b: S) => (await open(a, b)).body.conversation.id as string;
const send = (a: S, cid: string, body: Record<string, unknown>) => api().post(`${M}/conversations/${cid}/messages`).set(a.auth).send(body);
const say = async (a: S, cid: string, text = 'salut') => (await send(a, cid, { text })).body.message as { id: string };
const msgs = (a: S, cid: string, q = '') => api().get(`${M}/conversations/${cid}/messages${q}`).set(a.auth);
const inbox = (a: S, q = '') => api().get(`${M}/conversations${q}`).set(a.auth);
const follow = (a: S, b: S) => api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({});
const block = (a: S, b: S) => api().post(`/api/users/${b.user.id}/block`).set(a.auth).send({});
const policy = (a: S, allowMessagesFrom: string) => api().patch('/api/users/me/privacy').set(a.auth).send({ allowMessagesFrom });
const notifs = (a: S) => api().get('/api/notifications').set(a.auth);
const upload = (a: S, cid: string, contentType = 'image/png', sizeBytes = 50_000) => api().post(`${M}/upload-url`).set(a.auth).send({ conversationId: cid, contentType, sizeBytes });
/** Envoi simulé d'un média : URL signée → « PUT » direct → clé prête pour le message. */
async function mediaKey(a: S, cid: string, contentType = 'image/png', size = 50_000) {
  const r = await upload(a, cid, contentType, size);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  memStore.put(r.body.upload.key, size, contentType);
  return r.body.upload.key as string;
}

describe('ouverture d’une conversation', () => {
  it('est idempotente et la même pour les deux participants ; invisible dans la boîte tant qu’il n’y a pas de message', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const c1 = await open(a, b); const c2 = await open(a, b); const c3 = await open(b, a);
    expect(c1.status).toBe(200);
    expect(new Set([c1.body.conversation.id, c2.body.conversation.id, c3.body.conversation.id]).size).toBe(1);
    expect(await prisma.conversation.count()).toBe(1);
    expect(c1.body.conversation.other.username).toBe(b.user.username);
    expect(c1.body.conversation.other.email).toBeUndefined();
    expect(c1.body.conversation.canSend).toBe(true);
    expect((await inbox(a)).body.items).toEqual([]);
  });
  it('refuse soi-même (400), un inconnu, un compte suspendu ou bloqué (404)', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    expect((await open(a, a)).status).toBe(400);
    expect((await api().post(`${M}/conversations`).set(a.auth).send({ userId: 'nope' })).status).toBe(404);
    await prisma.user.update({ where: { id: b.user.id }, data: { status: 'SUSPENDED' } });
    expect((await open(a, b)).status).toBe(404);
    await block(a, c);
    expect((await open(a, c)).status).toBe(404);
    expect((await open(c, a)).status).toBe(404);
    expect((await api().post(`${M}/conversations`).set(a.auth).send({})).status).toBe(400);
  });
  it('respecte allowMessagesFrom : NOBODY et FOLLOWERS', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    await policy(b, 'NOBODY');
    const no = await open(a, b);
    expect(no.status).toBe(403); expect(no.body.error.code).toBe('MESSAGES_NOT_ALLOWED');
    expect(await prisma.conversation.count()).toBe(0);
    await policy(b, 'FOLLOWERS');
    expect((await open(a, b)).status).toBe(403);
    await follow(a, b); // a suit b → a peut écrire à b
    expect((await open(a, b)).status).toBe(200);
    await follow(b, c); // c ne suit pas b : l'inverse ne compte pas
    expect((await open(c, b)).status).toBe(403);
  });
  it('profil : viewer.canMessage reflète la règle', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const can = async () => (await api().get(`/api/users/${b.user.username}`).set(a.auth)).body.user.viewer.canMessage;
    expect(await can()).toBe(true);
    await policy(b, 'NOBODY');
    expect(await can()).toBe(false);
    await policy(b, 'FOLLOWERS'); await follow(a, b);
    expect(await can()).toBe(true);
  });
});

describe('envoi et lecture', () => {
  it('envoie, liste du plus récent au plus ancien (paginé) et rejette message vide / trop long / champs inconnus', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m1 = await say(a, cid, 'un'); const m2 = await say(b, cid, 'deux'); const m3 = await say(a, cid, 'trois');
    const p1 = await msgs(a, cid, '?limit=2');
    expect(p1.body.items.map((m: any) => m.id)).toEqual([m3.id, m2.id]);
    expect(p1.body.items.map((m: any) => m.mine)).toEqual([true, false]);
    const p2 = await msgs(a, cid, `?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((m: any) => m.id)).toEqual([m1.id]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await send(a, cid, { text: '   ' })).status).toBe(400);
    expect((await send(a, cid, {})).status).toBe(400);
    expect((await send(a, cid, { text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await send(a, cid, { text: 'ok', foo: 1 })).status).toBe(400);
    expect((await msgs(a, cid, '?cursor=zzz')).status).toBe(400);
  });
  it('un tiers ne voit ni n’écrit dans la conversation (404)', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    await say(a, cid);
    expect((await msgs(c, cid)).status).toBe(404);
    expect((await send(c, cid, { text: 'intrus' })).status).toBe(404);
    expect((await api().get(`${M}/conversations/${cid}`).set(c.auth)).status).toBe(404);
    expect((await api().post(`${M}/conversations/${cid}/read`).set(c.auth)).status).toBe(404);
    expect((await api().delete(`${M}/conversations/${cid}`).set(c.auth)).status).toBe(404);
  });
  it('boîte de réception : aperçu, non-lus par participant, tri par activité, pagination ; marquer lu', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const ab = await convId(a, b); const ac = await convId(a, c);
    await say(b, ab, 'un'); await say(b, ab, 'deux');
    await say(c, ac, 'coucou');
    await say(b, ab, 'dernier');
    const box = (await inbox(a)).body.items;
    expect(box.map((i: any) => i.id)).toEqual([ab, ac]);
    expect(box[0]).toMatchObject({ unreadCount: 3, lastMessage: { text: 'dernier', mine: false } });
    expect(box[1].unreadCount).toBe(1);
    expect((await api().get(`${M}/conversations/unread-count`).set(a.auth)).body.count).toBe(2);
    expect((await inbox(b)).body.items[0].unreadCount).toBe(0); // l'expéditeur n'a rien de non lu
    const p1 = await inbox(a, '?limit=1');
    expect(p1.body.items.map((i: any) => i.id)).toEqual([ab]);
    const p2 = await inbox(a, `?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: any) => i.id)).toEqual([ac]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await api().post(`${M}/conversations/${ab}/read`).set(a.auth)).status).toBe(204);
    expect((await api().get(`${M}/conversations/unread-count`).set(a.auth)).body.count).toBe(1);
    expect((await inbox(a)).body.items.find((i: any) => i.id === ab).unreadCount).toBe(0);
  });
  it('clientId : un renvoi ne crée pas de doublon (200, même message)', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const r1 = await send(a, cid, { text: 'x', clientId: 'client-abc-123' });
    const r2 = await send(a, cid, { text: 'x', clientId: 'client-abc-123' });
    expect(r1.status).toBe(201); expect(r2.status).toBe(200);
    expect(r2.body.message.id).toBe(r1.body.message.id);
    expect(await prisma.message.count()).toBe(1);
    expect((await inbox(b)).body.items[0].unreadCount).toBe(1);
    const [x, y] = await Promise.all([send(a, cid, { text: 'y', clientId: 'client-par-456' }), send(a, cid, { text: 'y', clientId: 'client-par-456' })]);
    expect(x.body.message.id).toBe(y.body.message.id);
    expect(await prisma.message.count()).toBe(2);
    expect((await send(a, cid, { text: 'x', clientId: 'a b' })).status).toBe(400);
  });
  it('politique d’envoi : NOBODY bloque, mais on peut répondre à qui nous a écrit', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    await policy(a, 'NOBODY');
    const cid = await convId(a, b);
    expect((await send(b, cid, { text: 'bonjour ?' })).status).toBe(403);
    expect((await api().get(`${M}/conversations/${cid}`).set(b.auth)).body.conversation).toMatchObject({ canSend: false, sendBlockedReason: 'NOT_ALLOWED' });
    expect((await send(a, cid, { text: 'je commence' })).status).toBe(201); // a a ouvert le contact
    expect((await send(b, cid, { text: 'je réponds' })).status).toBe(201);
    await policy(b, 'NOBODY');
    expect((await send(a, cid, { text: 'encore' })).status).toBe(201); // b avait déjà écrit
  });
  it('un message met la conversation à jour pour le destinataire et crée UNE notification regroupée', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await say(a, cid); await say(a, cid); await say(a, cid);
    const n = (await notifs(b)).body.items;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'NEW_MESSAGE', count: 3, read: false, targetId: cid, actor: { username: a.user.username } });
    expect((await api().get('/api/notifications/unread-count').set(b.auth)).body.count).toBe(1);
    await api().post(`${M}/conversations/${cid}/read`).set(b.auth); // ouvrir la conversation lit la notification
    expect((await api().get('/api/notifications/unread-count').set(b.auth)).body.count).toBe(0);
    await say(a, cid); // nouvelle notification non lue
    expect((await notifs(b)).body.items).toHaveLength(2);
  });
});

describe('blocage, masquage, suppression', () => {
  it('le blocage rend la conversation introuvable dans les deux sens ; le déblocage restitue l’historique', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await say(a, cid, 'avant');
    await block(b, a);
    expect((await send(a, cid, { text: 'x' })).status).toBe(404);
    expect((await msgs(b, cid)).status).toBe(404);
    expect((await inbox(a)).body.items).toEqual([]);
    expect((await inbox(b)).body.items).toEqual([]);
    expect((await api().get(`${M}/conversations/unread-count`).set(b.auth)).body.count).toBe(0);
    expect((await notifs(b)).body.items).toEqual([]); // notification de l'utilisateur bloqué masquée
    await api().delete(`/api/users/${a.user.id}/block`).set(b.auth);
    expect((await msgs(b, cid)).body.items).toHaveLength(1);
    expect((await inbox(b)).body.items).toHaveLength(1);
  });
  it('un compte suspendu disparaît de la boîte', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b); await say(b, cid);
    await prisma.user.update({ where: { id: b.user.id }, data: { status: 'SUSPENDED' } });
    expect((await inbox(a)).body.items).toEqual([]);
    expect((await msgs(a, cid)).status).toBe(404);
  });
  it('« supprimer la conversation » : masquée et vidée pour moi seulement ; un nouveau message la fait revenir sans l’ancien historique', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    await say(a, cid, 'ancien 1'); await say(b, cid, 'ancien 2');
    expect((await api().delete(`${M}/conversations/${cid}`).set(a.auth)).status).toBe(204);
    expect((await inbox(a)).body.items).toEqual([]);
    expect((await msgs(a, cid)).body.items).toEqual([]);
    expect((await msgs(b, cid)).body.items).toHaveLength(2);
    expect((await inbox(b)).body.items).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    await say(b, cid, 'nouveau');
    expect((await inbox(a)).body.items).toHaveLength(1);
    expect((await msgs(a, cid)).body.items.map((m: any) => m.text)).toEqual(['nouveau']);
    expect((await msgs(b, cid)).body.items).toHaveLength(3);
  });
  it('suppression d’un message : auteur seulement, pour tous, idempotente, contenu effacé, non-lu corrigé', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m = await say(a, cid, 'oups'); await say(a, cid, 'reste');
    expect((await inbox(b)).body.items[0].unreadCount).toBe(2);
    expect((await api().delete(`${M}/${m.id}`).set(b.auth)).status).toBe(404); // pas l'auteur
    expect((await api().delete(`${M}/${m.id}`).set(a.auth)).status).toBe(204);
    expect((await api().delete(`${M}/${m.id}`).set(a.auth)).status).toBe(204);
    const seen = (await msgs(b, cid)).body.items.find((x: any) => x.id === m.id);
    expect(seen).toMatchObject({ deleted: true, text: null, media: null });
    expect((await prisma.message.findUnique({ where: { id: m.id } }))!.text).toBeNull();
    expect((await inbox(b)).body.items[0].unreadCount).toBe(1);
    await api().post(`${M}/conversations/${cid}/read`).set(b.auth);
    const last = await say(a, cid, 'lu'); await api().post(`${M}/conversations/${cid}/read`).set(b.auth);
    await api().delete(`${M}/${last.id}`).set(a.auth); // déjà lu : le compteur ne descend pas sous 0
    expect((await inbox(b)).body.items[0].unreadCount).toBe(0);
  });
});

describe('médias', () => {
  it('upload-url → envoi direct → message ; aperçu « Photo » ; URL de lecture fournie', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const key = await mediaKey(a, cid);
    expect(key).toMatch(new RegExp(`^messages/${cid}/${a.user.id}/.+\\.png$`));
    const r = await send(a, cid, { mediaKey: key });
    expect(r.status).toBe(201);
    expect(r.body.message).toMatchObject({ kind: 'MEDIA', text: null, media: { type: 'IMAGE', mimeType: 'image/png', sizeBytes: 50_000 } });
    expect(r.body.message.media.url).toContain(key);
    expect(JSON.stringify(r.body)).not.toContain('"mediaKey"');
    expect((await inbox(b)).body.items[0].lastMessage.text).toBe('📷 Photo');
    const v = await mediaKey(a, cid, 'video/mp4', 2_000_000);
    const rv = await send(a, cid, { mediaKey: v, text: 'regarde' });
    expect(rv.body.message.media.type).toBe('VIDEO');
    expect((await inbox(b)).body.items[0].lastMessage.text).toBe('regarde');
  });
  it('refuse type non pris en charge, fichier trop gros, tiers, conversation bloquée', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    expect((await upload(a, cid, 'application/pdf')).status).toBe(400);
    expect((await upload(a, cid, 'image/png', 11 * 1024 * 1024)).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await upload(a, cid, 'video/mp4', 101 * 1024 * 1024)).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await upload(c, cid)).status).toBe(404);
    await block(b, a);
    expect((await upload(a, cid)).status).toBe(404);
  });
  it('contrôle la clé : celle d’un autre expéditeur ou d’une autre conversation, absente du stockage, déjà utilisée, type faux', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const ab = await convId(a, b); const ac = await convId(a, c);
    const k = await mediaKey(a, ab);
    expect((await send(a, ac, { mediaKey: k })).body.error.code).toBe('INVALID_MEDIA'); // autre conversation
    expect((await send(b, ab, { mediaKey: k })).body.error.code).toBe('INVALID_MEDIA'); // autre expéditeur
    expect((await send(a, ab, { mediaKey: `messages/${ab}/${a.user.id}/inconnu.png` })).body.error.code).toBe('UPLOAD_MISSING');
    expect((await send(a, ab, { mediaKey: `messages/${ab}/${a.user.id}/x.exe` })).body.error.code).toBe('INVALID_MEDIA');
    expect((await send(a, ab, { mediaKey: k })).status).toBe(201);
    expect((await send(a, ab, { mediaKey: k })).body.error.code).toBe('MEDIA_ALREADY_USED');
    const r = await upload(a, ab, 'image/png', 100);
    memStore.put(r.body.upload.key, 100, 'image/jpeg'); // le fichier réellement envoyé n'est pas celui annoncé
    expect((await send(a, ab, { mediaKey: r.body.upload.key })).body.error.code).toBe('TYPE_MISMATCH');
    const big = await upload(a, ab, 'image/png', 100);
    memStore.put(big.body.upload.key, 11 * 1024 * 1024, 'image/png');
    expect((await send(a, ab, { mediaKey: big.body.upload.key })).body.error.code).toBe('FILE_TOO_LARGE');
    expect(await memStore.head(big.body.upload.key)).toBeNull(); // fichier invalide supprimé
  });
  it('supprimer un message média supprime le fichier du stockage', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const k = await mediaKey(a, cid);
    const m = (await send(a, cid, { mediaKey: k })).body.message;
    expect(await memStore.head(k)).not.toBeNull();
    await api().delete(`${M}/${m.id}`).set(a.auth);
    expect(await memStore.head(k)).toBeNull();
  });
});

describe('messages payants', () => {
  const PAY = { operator: 'AIRTEL_MONEY', phone: '060 12 34 56' };
  const paid = async (price = 1000) => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    const sent = await send(creator, cid, { text: 'contenu secret', price: price });
    return { creator, fan, cid, id: sent.body.message.id as string, sent };
  };
  const unlock = (a: S, id: string, body: Record<string, unknown> = PAY) => api().post(`${M}/${id}/unlock`).set(a.auth).send(body);
  /** Lance le paiement (202) puis simule la confirmation de MyPVit. */
  const buy = async (a: S, id: string, amount?: number) => {
    const r = await unlock(a, id);
    expect(r.status).toBe(202);
    const ref = (await prisma.messagePurchase.findFirstOrThrow({ where: { id: r.body.purchase.id } })).reference!;
    const w = await settle(ref, 'SUCCESS', amount ? { amount } : {});
    expect(w.status).toBe(200);
    return { ref, purchaseId: r.body.purchase.id as string };
  };

  it('accepte un prix en EUR (2 € = 200 centimes), borne les prix par devise et refuse le paiement Mobile Money hors FCFA', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    const ok = await send(creator, cid, { text: 'x', price: 200, currency: 'EUR' });
    expect(ok.status).toBe(201);
    expect(ok.body.message.paid).toMatchObject({ price: 200, currency: 'EUR' });
    expect((await send(creator, cid, { text: 'x', price: 5, currency: 'EUR' })).status).toBe(400); // sous 0,15 €
    expect((await send(creator, cid, { text: 'x', price: 99_999, currency: 'EUR' })).status).toBe(400); // au-dessus de ~305 €
    expect((await send(creator, cid, { text: 'x', price: 1000, currency: 'GBP' })).status).toBe(400); // devise inconnue
    expect((await send(creator, cid, { text: 'x', currency: 'EUR' })).status).toBe(400); // devise sans prix
    const r = await unlock(fan, ok.body.message.id as string);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CURRENCY_NOT_PAYABLE');
    expect(await prisma.messagePurchase.count()).toBe(0);
  });

  it('réservé aux créateurs, prix dans les limites configurées', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    expect((await send(fan, cid, { text: 'x', price: 500 })).body.error.code).toBe('CREATOR_REQUIRED');
    for (const p of [99, 200_001, 0, -5]) expect((await send(creator, cid, { text: 'x', price: p })).status).toBe(400);
    expect((await send(creator, cid, { text: 'x', price: 99.5 })).status).toBe(400);
    expect((await send(creator, cid, { text: 'x', price: 100 })).status).toBe(201);
    expect((await send(creator, cid, { text: 'x', price: 200_000 })).status).toBe(201);
    const s = (await api().get(`${M}/settings`).set(fan.auth)).body;
    expect(s.paidMessages).toMatchObject({ min: 100, max: 200_000, currency: 'XAF', currencies: ['XAF', 'XOF', 'EUR', 'USD'], commissionBps: 2000, byCurrency: { XAF: { min: 100, max: 200_000 }, EUR: { min: 15, max: 30_490 } } });
    expect(s.payments).toEqual({ enabled: true, operators: ['AIRTEL_MONEY', 'MOOV_MONEY'], feePayer: 'CUSTOMER' });
  });
  it('le contenu est verrouillé pour le destinataire (liste, aperçu, notification) et visible pour l’expéditeur', async () => {
    const { creator, fan, cid, id } = await paid();
    const seen = (await msgs(fan, cid)).body.items[0];
    expect(seen).toMatchObject({ id, kind: null, text: null, media: null, paid: { price: 1000, locked: true, purchased: false, payment: null } });
    expect(JSON.stringify((await msgs(fan, cid)).body)).not.toContain('contenu secret');
    expect((await inbox(fan)).body.items[0].lastMessage.text).toBe('🔒 Message payant');
    const mine = (await msgs(creator, cid)).body.items[0];
    expect(mine).toMatchObject({ text: 'contenu secret', paid: { price: 1000, locked: false, purchased: false } });
    expect((await inbox(creator)).body.items[0].lastMessage.text).toContain('contenu secret');
  });
  it('un média payant n’expose ni URL ni type avant achat ; après achat, l’URL est signée et privée (jamais le CDN public)', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    const k = await mediaKey(creator, cid);
    const m = (await send(creator, cid, { mediaKey: k, price: 500 })).body.message;
    expect(m.media.url).toBe(`memory://private/${k}`); // l'expéditeur voit le sien, par une URL privée
    const seen = (await msgs(fan, cid)).body.items[0];
    expect(seen.media).toBeNull(); expect(seen.kind).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(k);
    await buy(fan, m.id);
    const after = (await msgs(fan, cid)).body.items[0];
    expect(after.media.url).toBe(`memory://private/${k}`);
    expect(JSON.stringify(after)).not.toContain('memory://read/');
  });
  it('tout média de message (même gratuit) utilise une URL privée signée, jamais l’URL publique du CDN', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const k = await mediaKey(a, cid);
    await send(a, cid, { mediaKey: k });
    const seen = (await msgs(b, cid)).body.items[0];
    expect(seen.media.url).toBe(`memory://private/${k}`);
  });

  it('achat asynchrone : 202 PENDING (rien révélé, aucun revenu), puis le webhook règle → PAID, montants figés, notification, rien de plus au second appel', async () => {
    const { creator, fan, cid, id } = await paid();
    const r = await unlock(fan, id);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'PENDING', purchase: { status: 'PENDING', operator: 'AIRTEL_MONEY', price: 1000, review: false }, message: { text: null, paid: { locked: true, purchased: false, payment: { status: 'PENDING' } } } });
    expect(memPay.requests).toHaveLength(1);
    expect(memPay.requests[0]).toMatchObject({ amount: 1000, operator: 'AIRTEL_MONEY', phone: '060123456' });
    let row = await prisma.messagePurchase.findFirstOrThrow();
    expect(row).toMatchObject({ status: 'PENDING', buyerId: fan.user.id, sellerId: creator.user.id, grossAmount: 1000, commissionAmount: 200, creatorAmount: 800, commissionBps: 2000, operator: 'AIRTEL_MONEY', payerPhoneHint: '3456', attempts: 1 });
    expect(row.reference).toMatch(/^M[0-9A-Z]{12}$/); expect(row.reference!.length).toBeLessThanOrEqual(13);
    expect(row.externalRef).toBe(`mem_${row.reference}`);
    expect(JSON.stringify(row)).not.toContain('060123456'); // le numéro complet n'est jamais conservé
    // Tant que le paiement n'est pas confirmé : verrouillé, aucun revenu, aucune notification.
    expect((await msgs(fan, cid)).body.items[0]).toMatchObject({ text: null, paid: { locked: true, purchased: false, payment: { purchaseId: row.id, status: 'PENDING' } } });
    expect((await msgs(creator, cid)).body.items[0].paid.purchased).toBe(false);
    expect((await notifs(creator)).body.items.find((x: any) => x.type === 'MESSAGE_PURCHASED')).toBeUndefined();
    const polled = await api().get(`${M}/purchases/${row.id}`).set(fan.auth);
    expect(polled.body.purchase.status).toBe('PENDING'); expect(polled.body.message).toBeUndefined();
    // Confirmation par MyPVit.
    const w = await settle(row.reference!, 'SUCCESS', { amount: 1000 });
    expect(w.status).toBe(200);
    expect(w.body).toEqual({ transactionId: `tx_${row.reference}`, responseCode: 200 }); // écho exigé par MyPVit
    row = await prisma.messagePurchase.findFirstOrThrow();
    expect(row).toMatchObject({ status: 'PAID', method: 'AIRTEL_MONEY', externalRef: `tx_${row.reference}` });
    expect(row.paidAt).toBeTruthy(); expect(row.commissionAmount + row.creatorAmount).toBe(row.grossAmount);
    const done = await api().get(`${M}/purchases/${row.id}`).set(fan.auth);
    expect(done.body).toMatchObject({ purchase: { status: 'PAID' }, message: { text: 'contenu secret', paid: { locked: false, purchased: true } } });
    expect((await msgs(fan, cid)).body.items[0]).toMatchObject({ text: 'contenu secret', paid: { locked: false, purchased: true, payment: null } });
    expect((await msgs(creator, cid)).body.items[0].paid.purchased).toBe(true);
    expect((await inbox(fan)).body.items[0].lastMessage.text).toBe('contenu secret');
    expect((await notifs(creator)).body.items.find((x: any) => x.type === 'MESSAGE_PURCHASED')).toMatchObject({ amount: 800, actor: { username: fan.user.username } });
    // Second déblocage et rejeu du webhook : aucun nouveau débit, aucune seconde notification.
    const again = await unlock(fan, id);
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ status: 'PAID', alreadyPurchased: true });
    expect((await settle(row.reference!, 'SUCCESS', { amount: 1000 })).status).toBe(200);
    expect(memPay.requests).toHaveLength(1); expect(await prisma.messagePurchase.count()).toBe(1);
    expect((await notifs(creator)).body.items.filter((x: any) => x.type === 'MESSAGE_PURCHASED')).toHaveLength(1);
  });
  it('commission d’un montant non rond : somme exacte', async () => {
    const { fan, id } = await paid(333);
    await buy(fan, id);
    expect(await prisma.messagePurchase.findFirstOrThrow()).toMatchObject({ grossAmount: 333, commissionAmount: 67, creatorAmount: 266 });
  });
  it('un opérateur Moov est transmis tel quel', async () => {
    const { fan, id } = await paid();
    await unlock(fan, id, { operator: 'MOOV_MONEY', phone: '+24107123456' });
    expect(memPay.requests[0]).toMatchObject({ operator: 'MOOV_MONEY', phone: '24107123456' });
  });
  it('refus net du prestataire : 402, achat FAILED, rien révélé ; nouvel essai avec une NOUVELLE référence, sans doublon de ligne', async () => {
    const { fan, cid, id } = await paid();
    memPay.rejectNext();
    const r = await unlock(fan, id);
    expect(r.status).toBe(402); expect(r.body.error.code).toBe('PAYMENT_FAILED');
    const first = await prisma.messagePurchase.findFirstOrThrow();
    expect(first.status).toBe('FAILED');
    expect((await msgs(fan, cid)).body.items[0].text).toBeNull();
    const ok = await unlock(fan, id);
    expect(ok.status).toBe(202);
    const row = await prisma.messagePurchase.findFirstOrThrow();
    expect(await prisma.messagePurchase.count()).toBe(1);
    expect(row).toMatchObject({ id: first.id, status: 'PENDING', attempts: 2 });
    expect(row.reference).not.toBe(first.reference);
    await settle(row.reference!, 'SUCCESS', { amount: 1000 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
  });
  it('prestataire injoignable (rien envoyé) : 502, achat FAILED, réessayable', async () => {
    const { fan, id } = await paid();
    memPay.notSentNext();
    const r = await unlock(fan, id);
    expect(r.status).toBe(502); expect(r.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('FAILED');
    expect((await unlock(fan, id)).status).toBe(202);
  });
  it('réponse perdue (UNCERTAIN) : 202, achat PENDING, AUCUN nouvel essai possible (409) — pas de double débit', async () => {
    const { fan, id } = await paid();
    memPay.uncertainNext();
    const r = await unlock(fan, id);
    expect(r.status).toBe(202); expect(r.body.status).toBe('PENDING');
    const second = await unlock(fan, id);
    expect(second.status).toBe(409); expect(second.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    expect(second.body.error.details.purchaseId).toBe(r.body.purchase.id);
    expect(memPay.requests).toHaveLength(1);
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'SUCCESS', { amount: 1000 }); // le callback finit par arriver
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
  });
  it('plusieurs déblocages simultanés : une seule demande de paiement', async () => {
    const { fan, id } = await paid();
    const res = await Promise.all([unlock(fan, id), unlock(fan, id), unlock(fan, id)]);
    expect(res.filter((r) => r.status === 202)).toHaveLength(1);
    expect(res.every((r) => r.status === 202 || r.status === 409)).toBe(true);
    expect(memPay.requests).toHaveLength(1);
    expect(await prisma.messagePurchase.count()).toBe(1);
  });
  it('échec confirmé par le webhook : achat FAILED, nouvel essai possible ; un rejeu de l’ancienne référence est ignoré', async () => {
    const { fan, id } = await paid();
    await unlock(fan, id);
    const oldRef = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    expect((await settle(oldRef, 'FAILED', { amount: 1000 })).status).toBe(200);
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('FAILED');
    expect((await unlock(fan, id)).status).toBe(202);
    const newRef = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    expect(newRef).not.toBe(oldRef);
    expect((await settle(oldRef, 'SUCCESS', { amount: 1000 })).status).toBe(200); // référence périmée : accusée, sans effet
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PENDING');
  });
  it('montant confirmé insuffisant : REVIEW (rien révélé, pas de nouvel essai)', async () => {
    const a = await paid();
    await unlock(a.fan, a.id);
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'SUCCESS', { amount: 900 });
    expect(await prisma.messagePurchase.findFirstOrThrow()).toMatchObject({ status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH' });
    expect((await msgs(a.fan, a.cid)).body.items[0]).toMatchObject({ text: null, paid: { payment: { status: 'REVIEW' } } });
    const blocked = await unlock(a.fan, a.id);
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('PAYMENT_UNDER_REVIEW');
    expect(memPay.requests).toHaveLength(1);
  });
  it('montant supérieur au prix (frais de l’opérateur compris) : PAID', async () => {
    const { fan, id } = await paid();
    await unlock(fan, id);
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'SUCCESS', { amount: 1030 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
  });
  it('un statut inconnu ou ambigu dans le webhook n’est jamais un succès', async () => {
    const { fan, id } = await paid();
    await unlock(fan, id);
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'PENDING');
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('FAILED'); // tout ce qui n'est pas SUCCESS est traité comme un échec définitif
  });
  it('succès tardif sur un achat déjà FAILED : REVIEW (argent pris, vérification manuelle), jamais ignoré', async () => {
    const { fan, id } = await paid();
    await unlock(fan, id);
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'FAILED');
    await settle(ref, 'SUCCESS', { amount: 1000 });
    expect(await prisma.messagePurchase.findFirstOrThrow()).toMatchObject({ status: 'REVIEW', reviewReason: 'LATE_SUCCESS' });
  });
  it('paiements non configurés : 503 sans aucune demande ; settings.payments.enabled = false', async () => {
    const { fan, id } = await paid();
    const original = memPay.operators;
    memPay.operators = () => [];
    try {
      const r = await unlock(fan, id);
      expect(r.status).toBe(503); expect(r.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
      expect((await api().get(`${M}/settings`).set(fan.auth)).body.payments).toMatchObject({ enabled: false, operators: [] });
    } finally { memPay.operators = original; }
    expect(memPay.requests).toHaveLength(0); expect(await prisma.messagePurchase.count()).toBe(0);
  });
  it('validation du déblocage : opérateur et numéro obligatoires et valides, champs inconnus refusés', async () => {
    const { fan, id } = await paid();
    for (const body of [{}, { operator: 'AIRTEL_MONEY' }, { phone: '060123456' }, { operator: 'VISA', phone: '060123456' }, { operator: 'AIRTEL_MONEY', phone: '12' }, { operator: 'AIRTEL_MONEY', phone: 'abcdefgh' }, { ...PAY, amount: 1 }]) {
      expect((await unlock(fan, id, body)).status).toBe(400);
    }
    expect(memPay.requests).toHaveLength(0); expect(await prisma.messagePurchase.count()).toBe(0);
  });
  it('refus : son propre message (400), message non payant ou supprimé ou inconnu (404), tiers (404), blocage (404)', async () => {
    const { creator, fan, cid, id } = await paid();
    const stranger = await signedIn(3);
    expect((await unlock(creator, id)).status).toBe(400);
    expect((await unlock(stranger, id)).status).toBe(404);
    expect((await unlock(fan, 'inconnu')).status).toBe(404);
    const free = await say(creator, cid, 'gratuit');
    expect((await unlock(fan, free.id)).status).toBe(404);
    const gone = (await send(creator, cid, { text: 'x', price: 200 })).body.message;
    await api().delete(`${M}/${gone.id}`).set(creator.auth);
    expect((await unlock(fan, gone.id)).status).toBe(404);
    await block(creator, fan);
    expect((await unlock(fan, id)).status).toBe(404);
    expect(memPay.requests).toHaveLength(0);
  });
  it('seul l’acheteur consulte son achat (404 pour le créateur, un tiers ou un identifiant inconnu)', async () => {
    const { creator, fan, id } = await paid();
    const r = await unlock(fan, id);
    const pid = r.body.purchase.id as string;
    expect((await api().get(`${M}/purchases/${pid}`).set(fan.auth)).status).toBe(200);
    expect((await api().get(`${M}/purchases/${pid}`).set(creator.auth)).status).toBe(404);
    expect((await api().get(`${M}/purchases/${pid}`).set((await signedIn(3)).auth)).status).toBe(404);
    expect((await api().get(`${M}/purchases/inconnu`).set(fan.auth)).status).toBe(404);
    expect((await api().get(`${M}/purchases/${pid}`)).status).toBe(401);
  });
  it('un message payant dont l’achat est PAID, PENDING ou REVIEW ne peut plus être supprimé ; sans achat, si', async () => {
    const { creator, fan, id, cid } = await paid();
    const free = (await send(creator, cid, { text: 'autre', price: 300 })).body.message;
    expect((await api().delete(`${M}/${free.id}`).set(creator.auth)).status).toBe(204);
    await unlock(fan, id); // PENDING
    let r = await api().delete(`${M}/${id}`).set(creator.auth);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('MESSAGE_PURCHASED');
    const ref = (await prisma.messagePurchase.findFirstOrThrow()).reference!;
    await settle(ref, 'SUCCESS', { amount: 100 }); // REVIEW
    expect((await api().delete(`${M}/${id}`).set(creator.auth)).status).toBe(409);
    await settle(ref, 'SUCCESS', { amount: 1000 }); // PAID (résolution du REVIEW par un callback conforme)
    r = await api().delete(`${M}/${id}`).set(creator.auth);
    expect(r.status).toBe(409);
  });
  it('un achat est une écriture financière : impossible de supprimer l’utilisateur ou le message d’un achat (clés étrangères RESTRICT)', async () => {
    const { creator, fan, id } = await paid();
    await buy(fan, id);
    await expect(prisma.user.delete({ where: { id: creator.user.id } })).rejects.toThrow();
    await expect(prisma.user.delete({ where: { id: fan.user.id } })).rejects.toThrow();
    await expect(prisma.message.delete({ where: { id } })).rejects.toThrow();
    expect(await prisma.messagePurchase.count()).toBe(1);
  });
  it('suppression du compte du créateur : contenu retiré (médias supprimés), achats conservés', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const cid = await convId(creator, fan);
    const k = await mediaKey(creator, cid);
    const m = (await send(creator, cid, { mediaKey: k, price: 500 })).body.message;
    await buy(fan, m.id);
    const del = await api().delete('/api/users/me').set(creator.auth).send({ password: 'Passw0rdOK' });
    expect(del.status).toBe(204);
    expect(await memStore.head(k)).toBeNull();
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ mediaKey: null, text: null }); expect(row.deletedAt).toBeTruthy();
    expect(await prisma.messagePurchase.count()).toBe(1);
    expect((await inbox(fan)).body.items).toEqual([]);
  });
});

describe('signalement de messages', () => {
  const report = (a: S, id: string) => api().post('/api/moderation/reports').set(a.auth).send({ targetType: 'MESSAGE', targetId: id, reason: 'HARASSMENT' });
  it('un participant signale le message de l’autre ; pas le sien, pas celui d’une conversation tierce, pas un message supprimé', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const cid = await convId(a, b);
    const m = await say(a, cid, 'insulte');
    expect((await report(b, m.id)).status).toBe(201);
    expect((await report(b, m.id)).status).toBe(200); // doublon ouvert : renvoyé tel quel
    expect((await report(a, m.id)).body.error.code).toBe('CANNOT_TARGET_SELF');
    expect((await report(c, m.id)).status).toBe(404);
    expect((await report(b, 'inconnu')).status).toBe(404);
    const d = await say(a, cid, 'effacé');
    await api().delete(`${M}/${d.id}`).set(a.auth);
    expect((await report(b, d.id)).status).toBe(404);
  });
  it('on peut signaler après avoir bloqué, mais plus un message antérieur à l’effacement de sa conversation', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const cid = await convId(a, b);
    const m = await say(a, cid, 'menace');
    await block(b, a);
    expect((await report(b, m.id)).status).toBe(201);
    await api().delete(`/api/users/${a.user.id}/block`).set(b.auth);
    const old = await say(a, cid, 'vieux');
    await api().delete(`${M}/conversations/${cid}`).set(b.auth);
    expect((await report(b, old.id)).status).toBe(404);
  });
});

describe('notifications', () => {
  it('liste, compteur, lecture individuelle et globale ; pas celle d’un autre', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const ab = await convId(a, b); const cb = await convId(c, b);
    await say(a, ab); await say(c, cb);
    const list = (await notifs(b)).body.items;
    expect(list).toHaveLength(2);
    expect((await api().get('/api/notifications/unread-count').set(b.auth)).body.count).toBe(2);
    expect((await api().post(`/api/notifications/${list[0].id}/read`).set(a.auth)).status).toBe(404);
    expect((await api().post(`/api/notifications/${list[0].id}/read`).set(b.auth)).status).toBe(204);
    expect((await api().post(`/api/notifications/${list[0].id}/read`).set(b.auth)).status).toBe(204); // idempotent
    expect((await api().get('/api/notifications/unread-count').set(b.auth)).body.count).toBe(1);
    expect((await api().post('/api/notifications/read-all').set(b.auth)).status).toBe(204);
    expect((await api().get('/api/notifications/unread-count').set(b.auth)).body.count).toBe(0);
    const p1 = await api().get('/api/notifications?limit=1').set(b.auth);
    expect(p1.body.items).toHaveLength(1); expect(p1.body.nextCursor).toBeTruthy();
    expect((await api().get('/api/notifications').send()).status).toBe(401);
  });
});

describe('sécurité générale', () => {
  it('toutes les routes exigent une session', async () => {
    for (const [m, p] of [['get', `${M}/conversations`], ['post', `${M}/conversations`], ['post', `${M}/upload-url`], ['post', `${M}/x/unlock`], ['delete', `${M}/x`], ['get', `${M}/settings`]] as const) {
      expect((await (api() as any)[m](p).send({})).status, `${m} ${p}`).toBe(401);
    }
  });
  it('« messages » et « notifications » sont des identifiants réservés', async () => {
    const r = await api().post('/api/auth/register').send({ email: 'z@example.com', username: 'messages', password: 'Passw0rdOK', displayName: 'Z', birthDate: '1995-06-15' });
    expect(r.status).toBe(400);
  });
});
