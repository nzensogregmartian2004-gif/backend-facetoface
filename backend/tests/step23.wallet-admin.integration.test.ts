import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { api, resetDb, signedIn } from './helpers';
import { creditCreatorWallet } from '../src/modules/wallet/wallet.service';

beforeEach(resetDb);

describe('Étape 23 — portefeuille et administration', () => {
  it('retrait : vérifie le solde, bloque le montant et crée la transaction financière', async () => {
    const creator = await signedIn(1);
    await creditCreatorWallet(prisma, {
      creatorId: creator.user.id,
      sourceType: 'TEST_EARNING',
      sourceId: 'step23-wallet',
      amount: 12000,
      currency: 'XAF',
    });

    const r = await api().post('/api/wallet/withdrawals').set(creator.auth).send({
      amount: 10000,
      currency: 'XAF',
      method: 'MOBILE_MONEY',
      destination: '060123456',
    });
    expect(r.status).toBe(201);
    expect(r.body.withdrawal).toMatchObject({ status: 'PENDING', amount: 10000, currency: 'XAF' });

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId_currency: { userId: creator.user.id, currency: 'XAF' } } });
    const tx = await prisma.financialTransaction.findUniqueOrThrow({ where: { reference: `W-${r.body.withdrawal.id}` } });
    expect(wallet.availableAmount).toBe(2000);
    expect(wallet.blockedAmount).toBe(10000);
    expect(tx).toMatchObject({ type: 'WITHDRAWAL', status: 'PENDING', grossAmount: 10000, creatorAmount: 10000 });
  });

  it('configuration : utilisateur refusé, administrateur autorisé, raison + version + audit conservés', async () => {
    const user = await signedIn(1);
    const denied = await api().get('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth);
    expect(denied.status).toBe(403);

    env.ADMIN_USER_IDS = user.user.id;
    const admin = await api().get('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth);
    expect(admin.status).toBe(200);
    expect(admin.body.value).toBe(20);

    const update = await api().patch('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth).send({ value: 25, reason: 'Test de versionnement étape 23' });
    expect(update.status).toBe(200);
    expect(update.body.value).toBe(25);

    const versions = await api().get('/api/admin/config/versions?key=COMMISSION.PLATFORM_PERCENT').set(user.auth);
    expect(versions.status).toBe(200);
    expect(versions.body.some((v: any) => v.newValue === 25 && v.reason === 'Test de versionnement étape 23')).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { adminId: user.user.id, action: 'CONFIG_UPDATE' } })).toBe(1);
  });
});
