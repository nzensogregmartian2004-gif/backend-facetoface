import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

const REV = '/api/monetization/creator/gifts-summary';

describe('étape 6 — tableau de bord créateur', () => {
  it('un non-créateur reçoit 403 sur le résumé des revenus', async () => {
    const user = await signedIn(1);
    expect((await api().get(REV).set(user.auth)).status).toBe(403);
  });

  it('le résumé additionne les cadeaux et pourboires, et le brut vaut commission plus net', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const gift = await prisma.gift.findFirst() ?? await prisma.gift.create({ data: { code: 'T_GIFT', name: 'T', symbol: 'T', meaning: 'T', pricePoints: 100, rarity: 'COMMON' } });
    await prisma.coinGiftTransaction.create({ data: { senderId: fan.user.id, creatorId: creator.user.id, giftId: gift.id, quantity: 1, pointsSpent: 100, grossAmount: 100, platformFee: 20, creatorAmount: 80, currency: 'XAF' } });
    await prisma.coinTipTransaction.create({ data: { senderId: fan.user.id, creatorId: creator.user.id, amount: 50, platformFee: 10, creatorAmount: 40, currency: 'XAF' } });
    const r = await api().get(`${REV}?range=30d`).set(creator.auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toEqual({ count: 2, gross: 150, commission: 30, net: 120 });
    expect(r.body.consistent).toBe(true);
  });

  it('le filtre de période exclut les envois plus anciens que la fenêtre', async () => {
    const creator = await creatorSignedIn(1); const fan = await signedIn(2);
    const gift = await prisma.gift.create({ data: { code: 'OLD_GIFT', name: 'O', symbol: 'O', meaning: 'O', pricePoints: 10, rarity: 'COMMON' } });
    await prisma.coinGiftTransaction.create({ data: { senderId: fan.user.id, creatorId: creator.user.id, giftId: gift.id, quantity: 1, pointsSpent: 10, grossAmount: 10, platformFee: 2, creatorAmount: 8, currency: 'XAF', createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    expect((await api().get(`${REV}?range=7d`).set(creator.auth)).body.total.count).toBe(0);
    expect((await api().get(`${REV}?range=12m`).set(creator.auth)).body.total.count).toBe(1);
  });

  it('la liste des Lives ne contient que ceux du créateur connecté, avec leurs statistiques', async () => {
    const a = await creatorSignedIn(1); const b = await creatorSignedIn(2);
    const created = await api().post('/api/live').set(a.auth).send({ title: 'Mon Live', visibility: 'PUBLIC', access: 'EVERYONE' });
    expect(created.status).toBe(201);
    await api().post('/api/live').set(b.auth).send({ title: 'Autre Live', visibility: 'PUBLIC', access: 'EVERYONE' });
    const mine = await api().get('/api/live/mine').set(a.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.lives.map((l: { title: string }) => l.title)).toEqual(['Mon Live']);
    expect(mine.body.lives[0]).toMatchObject({ status: 'LIVE', giftsCount: 0, giftsCreatorAmount: 0 });
  });

  it('l’éligibilité indique, pour chaque critère chiffré, le seuil exigé et la valeur actuelle', async () => {
    const creator = await creatorSignedIn(1);
    const r = await api().get('/api/monetization/creator/eligibility').set(creator.auth);
    expect(r.status).toBe(200);
    const subs = r.body.details.find((d: { key: string }) => d.key === 'subscribers');
    expect(subs).toMatchObject({ met: false, current: 0 });
    expect(subs.required).toBeGreaterThan(0);
  });
});
