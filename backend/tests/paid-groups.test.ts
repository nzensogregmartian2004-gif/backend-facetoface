import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, memPay, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const G = '/api/groups';
const PAY = { operator: 'AIRTEL_MONEY', phone: '060 12 34 56' };

const createGroup = async (owner: S, members: S[] = []) => (await api().post(G).set(owner.auth).send({ name: 'Cercle', memberIds: members.map((m) => m.user.id) })).body.group.id as string;
const inviteOf = async (owner: S, gid: string) => (await api().post(`${G}/${gid}/invites`).set(owner.auth).send({})).body.invite.token as string;
const setPrice = (a: S, gid: string, entryPrice: number | null) => api().patch(`${G}/${gid}`).set(a.auth).send({ entryPrice });
const join = (s: S, token: string) => api().post(`${G}/join`).set(s.auth).send({ token });
const preview = (s: S, token: string) => api().get(`${G}/invites/${token}`).set(s.auth);
const pay = (s: S, token: string) => api().post(`${G}/join/pay`).set(s.auth).send({ token, ...PAY });
const isMember = async (gid: string, s: S) => !!(await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: gid, userId: s.user.id } } }));
const purchaseOf = (s: S, gid: string) => prisma.groupAccessPurchase.findUniqueOrThrow({ where: { conversationId_buyerId: { conversationId: gid, buyerId: s.user.id } } });

describe('groupes à accès payant', () => {
  it('un groupe gratuit se rejoint comme avant ; payer un groupe gratuit est refusé', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const gid = await createGroup(a);
    const token = await inviteOf(a, gid);
    expect((await join(b, token)).status).toBe(200);
    expect((await api().get(`${G}/${gid}`).set(b.auth)).body.group.entry).toBeNull();
    const c = await signedIn(3);
    expect((await pay(c, token)).status).toBe(400);
  });

  it('seuls les administrateurs fixent le prix ; bornes et entier vérifiés', async () => {
    const a = await signedIn(1); const m = await signedIn(2);
    const gid = await createGroup(a, [m]);
    expect((await setPrice(m, gid, 500)).status).toBe(403);
    for (const bad of [50, 300_000, 1.5]) expect((await setPrice(a, gid, bad)).status).toBe(400);
    expect((await setPrice(a, gid, 500)).status).toBe(200);
    const owner = (await api().get(`${G}/${gid}`).set(a.auth)).body.group;
    expect(owner.entry).toEqual({ price: 500, currency: 'XAF' });
    expect(owner.isOwner).toBe(true);
    expect((await api().get(`${G}/${gid}`).set(m.auth)).body.group.isOwner).toBe(false);
  });

  it('l’aperçu de l’invitation montre le prix sans rien engager', async () => {
    const a = await signedIn(1); const d = await signedIn(4);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    const r = await preview(d, token);
    expect(r.status).toBe(200);
    expect(r.body.group).toMatchObject({ id: gid, entry: { price: 500, currency: 'XAF' } });
    expect(await isMember(gid, d)).toBe(false);
  });

  it('rejoindre sans payer est refusé (402) ; payer ouvre l’accès après règlement, avec commission, notification et revenus', async () => {
    const a = await signedIn(1); const d = await signedIn(4);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    const refused = await join(d, token);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('GROUP_PAYMENT_REQUIRED');

    const p = await pay(d, token);
    expect(p.status).toBe(202);
    expect(p.body.purchase).toMatchObject({ status: 'PENDING', price: 500 });
    expect(await isMember(gid, d)).toBe(false);
    expect(memPay.requests[0]).toMatchObject({ amount: 500, operator: 'AIRTEL_MONEY' });

    const row = await purchaseOf(d, gid);
    expect(await settle(row.reference!, 'SUCCESS', { amount: 500 })).toMatchObject({ status: 200 });
    expect(await isMember(gid, d)).toBe(true);
    expect((await prisma.conversationInvite.findUniqueOrThrow({ where: { token } })).uses).toBe(1);
    const paid = await purchaseOf(d, gid);
    expect(paid).toMatchObject({ status: 'PAID', commissionBps: 2000, grossAmount: 500, commissionAmount: 100, creatorAmount: 400 });

    const notes = (await api().get('/api/notifications').set(a.auth)).body.items as any[];
    expect(notes.find((n) => n.type === 'GROUP_ACCESS_PURCHASED')).toMatchObject({ amount: 400, actor: { username: d.user.username } });

    const summary = (await api().get(`${G}/${gid}/access`).set(a.auth)).body;
    expect(summary.commissionBps).toBe(2000);
    expect(summary.totals).toMatchObject({ buyers: 1, gross: 500, commission: 100, net: 400, currency: 'XAF' });
    expect((await api().get(`${G}/${gid}/access`).set(d.auth)).status).toBe(403);
  });

  it('déjà membre ou déjà payé : rien n’est débité une seconde fois', async () => {
    const a = await signedIn(1); const d = await signedIn(4);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    await pay(d, token);
    await settle((await purchaseOf(d, gid)).reference!, 'SUCCESS', { amount: 500 });
    const again = await pay(d, token);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('PAID');
    expect(memPay.requests).toHaveLength(1);
  });

  it('un règlement refusé ne donne aucun accès ; un nouvel essai reprend la ligne avec une nouvelle référence', async () => {
    const a = await signedIn(1); const e = await signedIn(5);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    memPay.rejectNext();
    const refused = await pay(e, token);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('PAYMENT_FAILED');
    expect((await purchaseOf(e, gid)).status).toBe('FAILED');
    expect(await isMember(gid, e)).toBe(false);
    const retry = await pay(e, token);
    expect(retry.status).toBe(202);
    expect(memPay.requests).toHaveLength(2);
    expect(memPay.requests[1].reference).not.toBe(memPay.requests[0].reference);
    expect((await purchaseOf(e, gid)).attempts).toBe(2);
  });

  it('montant confirmé inférieur au prix : vérification manuelle, aucun accès', async () => {
    const a = await signedIn(1); const f = await signedIn(6);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    await pay(f, token);
    await settle((await purchaseOf(f, gid)).reference!, 'SUCCESS', { amount: 300 });
    expect((await purchaseOf(f, gid)).status).toBe('REVIEW');
    expect(await isMember(gid, f)).toBe(false);
  });

  it('commission modifiable : appliquée aux achats suivants, les achats passés gardent leur taux', async () => {
    const a = await signedIn(1); const d = await signedIn(4); const g = await signedIn(7);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const token = await inviteOf(a, gid);
    await pay(d, token);
    await settle((await purchaseOf(d, gid)).reference!, 'SUCCESS', { amount: 500 });
    await prisma.appConfig.upsert({ where: { key: 'GROUP_ACCESS.COMMISSION_BPS' }, update: { value: 1000, enabled: true }, create: { key: 'GROUP_ACCESS.COMMISSION_BPS', value: 1000, type: 'INTEGER', enabled: true, description: 'test', defaultValue: 2000, category: 'COMMISSION' } });
    await pay(g, token);
    await settle((await purchaseOf(g, gid)).reference!, 'SUCCESS', { amount: 500 });
    expect((await purchaseOf(d, gid)).commissionBps).toBe(2000);
    expect(await purchaseOf(g, gid)).toMatchObject({ commissionBps: 1000, commissionAmount: 50, creatorAmount: 450 });
  });

  it('ajout direct refusé dans un groupe payant ; désactiver le prix rétablit l’entrée gratuite', async () => {
    const a = await signedIn(1); const h = await signedIn(8);
    const gid = await createGroup(a);
    await setPrice(a, gid, 500);
    const direct = await api().post(`${G}/${gid}/members`).set(a.auth).send({ userIds: [h.user.id] });
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('GROUP_PAYMENT_REQUIRED');
    await setPrice(a, gid, null);
    const token = await inviteOf(a, gid);
    expect((await join(h, token)).status).toBe(200);
  });

  it('le propriétaire qui quitte transmet la propriété à un autre membre', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const gid = await createGroup(a, [b]);
    await api().post(`${G}/${gid}/leave`).set(a.auth).send({});
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: gid } });
    expect(conv.ownerId).toBe(b.user.id);
  });
});
