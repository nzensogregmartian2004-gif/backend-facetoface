import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { api, creatorSignedIn, memStore, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

const PAY = { operator: 'AIRTEL_MONEY', phone: '060123456' };
const CALL = { operator: 'AIRTEL_MONEY', phone: '077123456' };

describe('Étape 24 — parcours end-to-end', () => {
  it('inscription → connexion → recherche → suivi → abonnement → vidéo → message payant → appel → revenus → portefeuille → retrait', async () => {
    const creator = await creatorSignedIn(1);
    const fanRegistration = await signedIn(2);

    // Recherche puis relation sociale.
    const search = await api().get('/api/search?q=user_1&type=creators').set(fanRegistration.auth);
    expect(search.status).toBe(200);
    expect(search.body.items.some((u: { id: string }) => u.id === creator.user.id)).toBe(true);

    const follow = await api().post(`/api/users/${creator.user.id}/follow`).set(fanRegistration.auth).send({});
    expect(follow.status).toBe(204);

    // Abonnement créateur + paiement réel via le webhook de test.
    const plan = await api().put('/api/subscriptions/me/plan').set(creator.auth).send({
      priceFcfa: 1000,
      benefits: { exclusiveContent: true, directMessages: true, subscriberCalls: true },
      isActive: true,
    });
    expect(plan.status).toBe(200);

    const subscription = await api().post(`/api/subscriptions/creators/${creator.user.id}`).set(fanRegistration.auth).send(PAY);
    expect(subscription.status).toBe(202);
    expect((await settle(subscription.body.payment.reference, 'SUCCESS', { amount: 1000 })).status).toBe(200);

    const activeSubscription = await api().get(`/api/subscriptions/creators/${creator.user.id}/me`).set(fanRegistration.auth);
    expect(activeSubscription.status).toBe(200);
    expect(activeSubscription.body.subscription.status).toBe('ACTIVE');

    // Publication vidéo : upload simulé puis lecture et vue.
    const draft = await api().post('/api/videos').set(creator.auth).send({ title: 'E2E vidéo', category: 'music' });
    expect(draft.status).toBe(201);
    const videoId = draft.body.video.id as string;
    const upload = await api().post(`/api/videos/${videoId}/upload-url`).set(creator.auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5_000_000 });
    expect(upload.status).toBe(200);
    memStore.put(upload.body.upload.key, 5_000_000, 'video/mp4');
    expect((await api().post(`/api/videos/${videoId}/complete-upload`).set(creator.auth).send({ durationSeconds: 60, width: 1280, height: 720 })).status).toBe(200);
    expect((await api().post(`/api/videos/${videoId}/publish`).set(creator.auth).send({})).status).toBe(200);

    const playback = await api().get(`/api/videos/${videoId}/playback`).set(fanRegistration.auth);
    expect(playback.status).toBe(200);
    expect(playback.body.playback.url).toBeTruthy();

    const view = await api().post(`/api/videos/${videoId}/view`).set(fanRegistration.auth).send({ watchedSeconds: 45 });
    expect(view.status).toBe(200);

    const comment = await api().post(`/api/videos/${videoId}/comments`).set(fanRegistration.auth).send({ text: 'Très bonne vidéo' });
    expect(comment.status).toBe(201);

    // Message payant : achat puis déblocage après confirmation du paiement.
    const conversation = await api().post('/api/messages/conversations').set(fanRegistration.auth).send({ userId: creator.user.id });
    expect(conversation.status).toBe(200);
    const conversationId = conversation.body.conversation.id as string;
    const paidMessage = await api().post(`/api/messages/conversations/${conversationId}/messages`).set(creator.auth).send({ text: 'Contenu réservé', priceFcfa: 500 });
    expect(paidMessage.status).toBe(201);
    const messageId = paidMessage.body.message.id as string;
    const unlock = await api().post(`/api/messages/${messageId}/unlock`).set(fanRegistration.auth).send(PAY);
    expect(unlock.status).toBe(202);
    const purchaseRow = await prisma.messagePurchase.findUniqueOrThrow({ where: { id: unlock.body.purchase.id } });
    expect((await settle(purchaseRow.reference!, 'SUCCESS', { amount: 500 })).status).toBe(200);
    const purchase = await api().get(`/api/messages/purchases/${purchaseRow.id}`).set(fanRegistration.auth);
    expect(purchase.status).toBe(200);
    expect(purchase.body.purchase.status).toBe('PAID');

    // Appel : paiement, acceptation, token et fin de session.
    const callSettings = await api().put('/api/calls/me/settings').set(creator.auth).send({
      pricingMode: 'PER_MINUTE', audioPriceFcfa: 100, maxDurationMinutes: 10, access: 'EVERYONE', isAvailable: true,
    });
    expect(callSettings.status).toBe(200);
    const callRequest = await api().post('/api/calls').set(fanRegistration.auth).send({ calleeId: creator.user.id, type: 'AUDIO', minutes: 1, ...CALL });
    expect(callRequest.status).toBe(202);
    const callId = callRequest.body.call.id as string;
    expect((await settle((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).reference!, 'SUCCESS', { amount: 100 })).status).toBe(200);
    expect((await api().post(`/api/calls/${callId}/accept`).set(creator.auth).send({})).status).toBe(200);
    expect((await api().post(`/api/calls/${callId}/token`).set(fanRegistration.auth).send({})).status).toBe(200);
    expect((await api().post(`/api/calls/${callId}/end`).set(fanRegistration.auth).send({})).status).toBe(200);

    // Revenus créateur puis portefeuille et retrait.
    const earnings = await api().get('/api/monetization/creator/earnings?currency=XAF').set(creator.auth);
    expect(earnings.status).toBe(200);
    expect(earnings.body.balances.length).toBeGreaterThan(0);

    const wallet = await api().get('/api/wallet?currency=XAF').set(creator.auth);
    expect(wallet.status).toBe(200);
    expect(wallet.body.wallets.length).toBe(1);
    expect(wallet.body.wallets[0].availableAmount).toBeGreaterThanOrEqual(800);

    // Le minimum de retrait réel (WALLET_MIN_WITHDRAWAL_AMOUNT, 5000 par défaut) dépasse les gains de ce parcours : on l'abaisse pour ce test seulement.
    const mutableEnv = env as Record<string, unknown>;
    const savedMin = mutableEnv.WALLET_MIN_WITHDRAWAL_AMOUNT;
    mutableEnv.WALLET_MIN_WITHDRAWAL_AMOUNT = 500;
    let withdrawal;
    try {
      withdrawal = await api().post('/api/wallet/withdrawals').set(creator.auth).send({ amount: 500, currency: 'XAF', method: 'MOBILE_MONEY', destination: '060123456' });
    } finally { mutableEnv.WALLET_MIN_WITHDRAWAL_AMOUNT = savedMin; }
    expect(withdrawal.status).toBe(201);
    expect(withdrawal.body.withdrawal.status).toBe('PENDING');

    const withdrawals = await api().get('/api/wallet/withdrawals?currency=XAF').set(creator.auth);
    expect(withdrawals.status).toBe(200);
    expect(withdrawals.body.withdrawals[0].id).toBe(withdrawal.body.withdrawal.id);
  });

  it('erreurs critiques du parcours : paiement refusé, webhook invalide et permission administrateur', async () => {
    const creator = await creatorSignedIn(1);
    const user = await signedIn(2);
    await api().put('/api/subscriptions/me/plan').set(creator.auth).send({ priceFcfa: 1000, benefits: {}, isActive: true });

    const rejected = await api().post(`/api/subscriptions/creators/${creator.user.id}`).set(user.auth).send(PAY);
    expect(rejected.status).toBe(202);
    const failed = await settle(rejected.body.payment.reference, 'FAILED', { amount: 1000 });
    expect(failed.status).toBe(200);
    const sub = await api().get(`/api/subscriptions/creators/${creator.user.id}/me`).set(user.auth);
    expect(sub.body.subscription.status).not.toBe('ACTIVE');

    expect((await api().post('/api/webhooks/mypvit/callback/faux').send({ merchantReferenceId: rejected.body.payment.reference, status: 'SUCCESS', amount: 1000 })).status).toBe(404);
    expect((await api().get('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth)).status).toBe(403);
    expect((await api().get('/api/wallet').set(user.auth)).status).toBe(200);
  });
});