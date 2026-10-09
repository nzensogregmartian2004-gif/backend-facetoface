import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, memPay, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const C = '/api/coins';

const catalog = async (s: S) => (await api().get(`${C}/catalog`).set(s.auth)).body as { gifts: { id: string; pricePoints: number }[]; packages: { id: string }[] };
const balance = async (s: S) => (await api().get(`${C}/balance`).set(s.auth)).body.balance as number;
const giveCoins = (s: S, n: number) => prisma.coinWallet.upsert({ where: { userId: s.user.id }, create: { userId: s.user.id, balance: n }, update: { balance: n } });
const buy = (s: S, packageId: string) => api().post(`${C}/purchases`).set(s.auth).send({ packageId, operator: 'AIRTEL_MONEY', phone: '+24177000001' });
const sendGift = (s: S, body: Record<string, unknown>) => api().post(`${C}/gifts/send`).set(s.auth).send(body);
const sendTip = (s: S, body: Record<string, unknown>) => api().post(`${C}/tips/send`).set(s.auth).send(body);

describe('étape 1 — coins : crédit, idempotence, statut, bornes', () => {
  it('crédite le solde une seule fois après un succès, même si le webhook est rejoué', async () => {
    const a = await signedIn(1);
    const pkg = (await catalog(a)).packages[0];
    const r = await buy(a, pkg.id);
    expect(r.status).toBe(202);
    const reference = (await prisma.coinPurchase.findUniqueOrThrow({ where: { id: r.body.purchase.id } })).reference;
    expect(await balance(a)).toBe(0);
    await settle(reference);
    await settle(reference);
    expect(await balance(a)).toBe(r.body.purchase.points);
  });

  it('un succès reçu après un échec part en vérification, sans crédit', async () => {
    const a = await signedIn(1);
    const pkg = (await catalog(a)).packages[0];
    memPay.rejectNext();
    expect((await buy(a, pkg.id)).status).toBe(400);
    const p = await prisma.coinPurchase.findFirstOrThrow({ where: { userId: a.user.id } });
    expect(p.status).toBe('FAILED');
    await settle(p.reference);
    expect((await prisma.coinPurchase.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('REVIEW');
    expect(await balance(a)).toBe(0);
  });

  it('un même envoi de cadeau (même clé) ne débite qu’une fois ; le créateur reçoit la part de 80 %', async () => {
    const a = await signedIn(1); const creator = await signedIn(2);
    await giveCoins(a, 1000);
    const gift = (await catalog(a)).gifts[0];
    const quantity = 5; const points = gift.pricePoints * quantity;
    const key = 'envoi-unique-0001';
    const first = await sendGift(a, { creatorId: creator.user.id, giftId: gift.id, quantity, idempotencyKey: key });
    expect(first.status).toBe(201);
    const replay = await sendGift(a, { creatorId: creator.user.id, giftId: gift.id, quantity, idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(replay.body.gift.id).toBe(first.body.gift.id);
    expect(await balance(a)).toBe(1000 - points);
    expect(first.body.gift.creatorAmount).toBe(points - Math.floor(points * 0.2));
    expect(await prisma.coinGiftTransaction.count({ where: { senderId: a.user.id } })).toBe(1);
    expect(await prisma.coinLedgerEntry.count({ where: { sourceType: 'GIFT', sourceId: first.body.gift.id } })).toBe(1);
  });

  it('un même pourboire (même clé) ne débite qu’une fois', async () => {
    const a = await signedIn(1); const creator = await signedIn(2);
    await giveCoins(a, 1000);
    const key = 'pourboire-unique-01';
    expect((await sendTip(a, { creatorId: creator.user.id, amount: 200, idempotencyKey: key })).status).toBe(201);
    expect((await sendTip(a, { creatorId: creator.user.id, amount: 200, idempotencyKey: key })).status).toBe(201);
    expect(await balance(a)).toBe(800);
    expect(await prisma.coinTipTransaction.count({ where: { senderId: a.user.id } })).toBe(1);
  });

  it('solde insuffisant : 409 et aucun débit ni cadeau enregistré', async () => {
    const a = await signedIn(1); const creator = await signedIn(2);
    await giveCoins(a, 0);
    const gift = (await catalog(a)).gifts[0];
    expect((await sendGift(a, { creatorId: creator.user.id, giftId: gift.id, quantity: 1 })).status).toBe(409);
    expect(await balance(a)).toBe(0);
    expect(await prisma.coinGiftTransaction.count({ where: { senderId: a.user.id } })).toBe(0);
  });

  it('un pourboi hors limites est refusé avant tout débit', async () => {
    const a = await signedIn(1); const creator = await signedIn(2);
    await giveCoins(a, 1000);
    expect((await sendTip(a, { creatorId: creator.user.id, amount: 10_000_000 })).status).toBe(400);
    expect(await balance(a)).toBe(1000);
  });

  it('le statut d’un achat n’est visible que pour son acheteur', async () => {
    const a = await signedIn(1); const other = await signedIn(2);
    const pkg = (await catalog(a)).packages[0];
    const r = await buy(a, pkg.id);
    const own = await api().get(`${C}/purchases/${r.body.purchase.id}`).set(a.auth);
    expect(own.status).toBe(200);
    expect(own.body.purchase.status).toBe('PENDING');
    expect((await api().get(`${C}/purchases/${r.body.purchase.id}`).set(other.auth)).status).toBe(404);
  });

  it('la commission des cadeaux se lit dans la configuration (COINS.COMMISSION_BPS)', async () => {
    const key = 'COINS.COMMISSION_BPS';
    await prisma.appConfig.upsert({ where: { key }, create: { key, value: 1000, defaultValue: 2000, type: 'INTEGER', description: 'test', category: 'COMMISSION' }, update: { value: 1000, enabled: true } });
    try {
      const a = await signedIn(1); const creator = await signedIn(2);
      await giveCoins(a, 1000);
      const gift = (await catalog(a)).gifts[0];
      const points = gift.pricePoints * 10;
      const r = await sendGift(a, { creatorId: creator.user.id, giftId: gift.id, quantity: 10 });
      expect(r.status).toBe(201);
      expect(r.body.gift.platformFee).toBe(Math.floor(points * 0.1));
      expect(r.body.gift.creatorAmount).toBe(points - Math.floor(points * 0.1));
    } finally {
      await prisma.appConfig.deleteMany({ where: { key } });
    }
  });
});
