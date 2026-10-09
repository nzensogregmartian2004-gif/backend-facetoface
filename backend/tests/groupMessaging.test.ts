import { beforeEach, describe, expect, it } from 'vitest';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';
const G = '/api/groups';

const groupId = async (owner: S, memberIds: string[], extra: Record<string, unknown> = {}) => {
  const r = await api().post(G).set(owner.auth).send({ name: 'Équipe', memberIds, ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.group.id as string;
};
const conv = (s: S, cid: string) => api().get(`${M}/conversations/${cid}`).set(s.auth);
const send = (s: S, cid: string, body: Record<string, unknown>) => api().post(`${M}/conversations/${cid}/messages`).set(s.auth).send(body);
const inbox = (s: S) => api().get(`${M}/conversations`).set(s.auth);
const leave = (s: S, gid: string) => api().post(`${G}/${gid}/leave`).set(s.auth).send({});
const unread = async (s: S, cid: string) => (await conv(s, cid)).body.conversation.unreadCount as number;

describe('messagerie de groupe', () => {
  it('est visible pour chaque membre : type groupe, pas d’interlocuteur unique, effectif correct', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupId(a, [b.user.id, c.user.id]);
    for (const s of [a, b, c]) {
      const r = await conv(s, gid);
      expect(r.status).toBe(200);
      expect(r.body.conversation).toMatchObject({ id: gid, isGroup: true, other: null, memberCount: 3 });
    }
    expect((await conv(a, gid)).body.conversation.myRole).toBe('ADMIN');
    expect((await conv(b, gid)).body.conversation.myRole).toBe('MEMBER');
    const items = (await inbox(b)).body.items as { id: string }[];
    expect(items.map((i) => i.id)).toContain(gid);
  });

  it('un message atteint tous les autres membres (non-lus) ; l’auteur n’a aucun non-lu', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupId(a, [b.user.id, c.user.id]);
    expect((await send(a, gid, { text: 'bonjour à tous' })).status).toBe(201);
    expect(await unread(b, gid)).toBe(1);
    expect(await unread(c, gid)).toBe(1);
    expect(await unread(a, gid)).toBe(0);
  });

  it('un non-membre ne voit pas le groupe et ne peut pas y écrire', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const outsider = await signedIn(4);
    const gid = await groupId(a, [b.user.id]);
    expect((await conv(outsider, gid)).status).toBe(404);
    expect((await send(outsider, gid, { text: 'intrus' })).status).toBe(404);
  });

  it('après un départ : le membre sorti perd l’accès, les autres continuent de recevoir', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupId(a, [b.user.id, c.user.id]);
    expect((await leave(b, gid)).status).toBe(204);
    expect((await conv(b, gid)).status).toBe(404);
    expect((await send(a, gid, { text: 'après le départ' })).status).toBe(201);
    expect(await unread(c, gid)).toBe(1);
    const items = (await inbox(b)).body.items as { id: string }[];
    expect(items.map((i) => i.id)).not.toContain(gid);
  });

  it('supprimer un message retire le non-lu de chaque destinataire qui ne l’avait pas lu', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    const gid = await groupId(a, [b.user.id, c.user.id]);
    const sent = (await send(a, gid, { text: 'à supprimer' })).body.message as { id: string };
    expect(await unread(b, gid)).toBe(1);
    expect((await api().delete(`${M}/${sent.id}`).set(a.auth)).status).toBe(204);
    expect(await unread(b, gid)).toBe(0);
    expect(await unread(c, gid)).toBe(0);
  });

  it('une boîte de réception reste accessible quand le groupe n’a plus d’autre membre', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const gid = await groupId(a, [b.user.id]);
    expect((await send(a, gid, { text: 'seul désormais' })).status).toBe(201);
    expect((await leave(b, gid)).status).toBe(204);
    const list = await inbox(a);
    expect(list.status).toBe(200);
    expect((list.body.items as { id: string }[]).map((i) => i.id)).toContain(gid);
    expect((await conv(a, gid)).body.conversation.memberCount).toBe(1);
  });

  it('un groupe qui désactive les contenus payants refuse les messages payants', async () => {
    const owner = await creatorSignedIn(1); const b = await signedIn(2);
    const closed = await groupId(owner, [b.user.id], { allowPaidContent: false });
    expect((await send(owner, closed, { text: 'payant', price: 500, currency: 'XAF' })).status).toBe(403);
    const open = await groupId(owner, [b.user.id]);
    expect((await send(owner, open, { text: 'payant', price: 500, currency: 'XAF' })).status).toBe(201);
  });

  it('une conversation directe garde son comportement : type non groupe et interlocuteur présent', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const r = await api().post(`${M}/conversations`).set(a.auth).send({ userId: b.user.id });
    expect(r.status).toBe(200);
    expect(r.body.conversation).toMatchObject({ isGroup: false, other: { id: b.user.id } });
  });
});
