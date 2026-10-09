import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, memStore, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

const PAY = { operator: 'AIRTEL_MONEY', phone: '060123456' };

describe('Étape 23 — créateurs et paiements', () => {
  it('abonnement créateur : paiement confirmé, commission tracée et revenu créateur créé', async () => {
    const creator = await creatorSignedIn(1);
    const fan = await signedIn(2);

    const plan = await api().put('/api/subscriptions/me/plan').set(creator.auth).send({
      price: 1000,
      benefits: { exclusiveContent: true, directMessages: true },
      isActive: true,
    });
    expect(plan.status).toBe(200);

    const sub = await api().post(`/api/subscriptions/creators/${creator.user.id}`).set(fan.auth).send(PAY);
    expect(sub.status).toBe(202);
    const reference = sub.body.payment.reference as string;

    expect(await settle(reference, 'SUCCESS', { amount: 1000 })).toMatchObject({ status: 200 });

    const payment = await prisma.creatorSubscriptionPayment.findUniqueOrThrow({ where: { reference } });
    const subscription = await prisma.creatorSubscription.findUniqueOrThrow({
      where: { subscriberId_creatorId: { subscriberId: fan.user.id, creatorId: creator.user.id } },
    });
    const earning = await prisma.creatorEarning.findFirst({ where: { sourceId: payment.id } });

    expect(payment).toMatchObject({ status: 'PAID', grossAmount: 1000, commissionAmount: 200, creatorAmount: 800, commissionBps: 2000 });
    expect(subscription.status).toBe('ACTIVE');
    expect(earning).toMatchObject({ grossAmount: 1000, creatorAmount: 800, platformFeeAmount: 200, status: 'AVAILABLE' });
  });

  it('vidéo personnalisée : demande → offre → paiement → livraison → validation et revenu créateur', async () => {
    const creator = await creatorSignedIn(1);
    const buyer = await signedIn(2);

    const created = await api().post(`/api/custom-videos/creators/${creator.user.id}/requests`)
      .set(buyer.auth).send({ requestText: 'Une vidéo personnalisée de démonstration' });
    expect(created.status).toBe(201);
    const id = created.body.request.id as string;

    expect((await api().post(`/api/custom-videos/${id}/offer`).set(creator.auth).send({ price: 2000, deadlineDays: 7 })).status).toBe(200);
    const paid = await api().post(`/api/custom-videos/${id}/pay`).set(buyer.auth).send(PAY);
    expect(paid.status).toBe(202);
    const reference = paid.body.payment.reference as string;

    expect((await settle(reference, 'SUCCESS', { amount: 2000 })).status).toBe(200);
    expect((await api().post(`/api/custom-videos/${id}/accept`).set(creator.auth).send({})).status).toBe(200);

    const upload = await api().post(`/api/custom-videos/${id}/upload-url`).set(creator.auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5_000_000 });
    expect(upload.status).toBe(200);
    memStore.put(upload.body.upload.key, 5_000_000, 'video/mp4');
    expect((await api().post(`/api/custom-videos/${id}/complete-upload`).set(creator.auth).send({ durationSeconds: 30 })).status).toBe(200);
    expect((await api().post(`/api/custom-videos/${id}/complete`).set(buyer.auth).send({})).status).toBe(200);

    const payment = await prisma.customVideoPayment.findUniqueOrThrow({ where: { reference } });
    const earning = await prisma.creatorEarning.findFirst({ where: { sourceId: payment.id } });
    expect(payment).toMatchObject({ status: 'PAID', grossAmount: 2000, commissionAmount: 400, creatorAmount: 1600 });
    expect(earning).toMatchObject({ creatorAmount: 1600, platformFeeAmount: 400, status: 'AVAILABLE' });
  });

  it('vidéo personnalisée refusée après paiement : le remboursement est explicitement dû', async () => {
    const creator = await creatorSignedIn(1);
    const buyer = await signedIn(2);
    const created = await api().post(`/api/custom-videos/creators/${creator.user.id}/requests`)
      .set(buyer.auth).send({ requestText: 'Demande à rembourser' });
    const id = created.body.request.id as string;
    await api().post(`/api/custom-videos/${id}/offer`).set(creator.auth).send({ price: 2000, deadlineDays: 7 });
    const paid = await api().post(`/api/custom-videos/${id}/pay`).set(buyer.auth).send(PAY);
    expect((await settle(paid.body.payment.reference, 'SUCCESS', { amount: 2000 })).status).toBe(200);

    const declined = await api().post(`/api/custom-videos/${id}/decline`).set(creator.auth).send({});
    expect(declined.status).toBe(200);
    expect(declined.body.request.status).toBe('REFUND_DUE');
    expect(declined.body.refund.status).toBe('DUE');
  });
});
