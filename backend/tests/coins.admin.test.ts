import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { api, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const C = '/api/coins';
const A = '/api/admin/coins';

const asAdmin = async () => {
  const admin = await signedIn(1);
  env.ADMIN_USER_IDS = admin.user.id;
  return admin;
};
const catalog = async (s: S) => (await api().get(`${C}/catalog`).set(s.auth)).body as { gifts: { id: string; name: string }[] };
const giveCoins = (s: S, n: number) => prisma.coinWallet.upsert({ where: { userId: s.user.id }, create: { userId: s.user.id, balance: n }, update: { balance: n } });
const balanceOf = async (s: S) => (await prisma.coinWallet.findUnique({ where: { userId: s.user.id } }))?.balance ?? 0;

describe('étape 3 — administration du catalogue', () => {
  it('un non-administrateur reçoit 403 sur les routes de catalogue et d’ajustement', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    const gift = (await catalog(admin)).gifts[0];
    expect((await api().patch(`${C}/admin/gifts/${gift.id}`).set(user.auth).send({ active: false })).status).toBe(403);
    expect((await api().post(`${A}/users/${user.user.id}/adjust`).set(user.auth).send({ amount: 100, reason: 'Tentative non autorisée' })).status).toBe(403);
    expect((await api().get(`${A}/audit`).set(user.auth)).status).toBe(403);
  });

  it('désactiver un cadeau le retire du catalogue client et journalise avant / après', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    const gift = (await catalog(admin)).gifts[0];
    const r = await api().patch(`${C}/admin/gifts/${gift.id}`).set(admin.auth).send({ active: false, reason: 'Retrait temporaire' });
    expect(r.status).toBe(200);
    expect((await catalog(user)).gifts.map((g) => g.id)).not.toContain(gift.id);
    const log = await prisma.adminAuditLog.findFirst({ where: { action: 'COINS_GIFT_UPDATE', targetId: gift.id } });
    expect(log?.adminId).toBe(admin.user.id);
    expect(log?.reason).toBe('Retrait temporaire');
    const meta = log?.metadata as { before: { active: boolean }; after: { active: boolean } };
    expect(meta.before.active).toBe(true);
    expect(meta.after.active).toBe(false);
  });

  it('un prix invalide est refusé avant toute écriture', async () => {
    const admin = await asAdmin();
    const gift = (await catalog(admin)).gifts[0];
    expect((await api().patch(`${C}/admin/gifts/${gift.id}`).set(admin.auth).send({ pricePoints: 0 })).status).toBe(400);
    expect(await prisma.adminAuditLog.count({ where: { targetId: gift.id } })).toBe(0);
  });
});

describe('étape 3 — ajustement de solde', () => {
  it('un ajustement crédite le solde, laisse une ligne de grand livre et une entrée d’audit', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    const r = await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: 300, reason: 'Compensation panne paiement' });
    expect(r.status).toBe(201);
    expect(await balanceOf(user)).toBe(300);
    expect(await prisma.coinLedgerEntry.count({ where: { userId: user.user.id, type: 'ADJUSTMENT', sourceType: 'ADMIN_ADJUSTMENT' } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: 'COINS_ADJUST', targetId: user.user.id, reason: 'Compensation panne paiement' } })).toBe(1);
  });

  it('un ajustement sans motif, nul ou trop grand est refusé', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    expect((await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: 100 })).status).toBe(400);
    expect((await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: 0, reason: 'Motif valable' })).status).toBe(400);
    expect((await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: 10_001, reason: 'Motif valable' })).status).toBe(400);
    expect(await balanceOf(user)).toBe(0);
  });

  it('un débit supérieur au solde est refusé sans rien écrire', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    await giveCoins(user, 50);
    const r = await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: -200, reason: 'Correction doublon' });
    expect(r.status).toBe(409);
    expect(await balanceOf(user)).toBe(50);
    expect(await prisma.adminAuditLog.count({ where: { action: 'COINS_ADJUST', targetId: user.user.id } })).toBe(0);
  });

  it('la consultation donne le solde et les derniers mouvements', async () => {
    const admin = await asAdmin(); const user = await signedIn(2);
    await api().post(`${A}/users/${user.user.id}/adjust`).set(admin.auth).send({ amount: 120, reason: 'Compensation panne paiement' });
    const r = await api().get(`${A}/users/${user.user.id}`).set(admin.auth);
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe(120);
    expect(r.body.entries.length).toBeGreaterThan(0);
  });
});
