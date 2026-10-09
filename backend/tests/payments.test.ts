import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { __resetMypvitState, checkTransactionStatus, initiatePayment, receiveSecretFromWebhook } from '../src/modules/payments/mypvit.client';
import { reconcilePurchases } from '../src/modules/payments/reconcile';
import { api, creatorSignedIn, memPay, resetDb, settle, signedIn, WEBHOOK_TOKEN } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const M = '/api/messages';
const PAY = { operator: 'AIRTEL_MONEY', phone: '060123456' };

/** Un message payant, un acheteur, un paiement lancé (PENDING). */
async function pending(price = 1000) {
  const creator = await creatorSignedIn(1); const fan = await signedIn(2);
  const cid = (await api().post(`${M}/conversations`).set(fan.auth).send({ userId: creator.user.id })).body.conversation.id as string;
  const m = (await api().post(`${M}/conversations/${cid}/messages`).set(creator.auth).send({ text: 'secret', price: price })).body.message;
  const r = await api().post(`${M}/${m.id}/unlock`).set(fan.auth).send(PAY);
  const row = await prisma.messagePurchase.findFirstOrThrow();
  return { creator: creator as S, fan: fan as S, cid, messageId: m.id as string, status: r.status, row };
}
const age = (id: string, seconds: number) => prisma.messagePurchase.update({ where: { id }, data: { initiatedAt: new Date(Date.now() - seconds * 1000) } });

describe('webhooks MyPVit : protection', () => {
  it('jeton absent ou faux : 404 (la route n’existe pas pour qui ne connaît pas le jeton), aucun effet', async () => {
    const { row } = await pending();
    for (const t of ['faux', 'x'.repeat(40), WEBHOOK_TOKEN + 'a']) {
      expect((await api().post(`/api/webhooks/mypvit/callback/${t}`).send({ merchantReferenceId: row.reference, status: 'SUCCESS', amount: 1000 })).status).toBe(404);
      expect((await api().post(`/api/webhooks/mypvit/secret/${t}`).send({ secret: 'abc' })).status).toBe(404);
    }
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PENDING');
  });
  it('payload invalide : 400 ; référence inconnue : accusée (200) sans effet', async () => {
    await pending();
    const url = `/api/webhooks/mypvit/callback/${WEBHOOK_TOKEN}`;
    expect((await api().post(url).send({})).status).toBe(400);
    expect((await api().post(url).send({ merchantReferenceId: 'X', status: 'SUCCESS', amount: 'abc' })).status).toBe(400);
    const r = await api().post(url).send({ merchantReferenceId: 'INCONNUE', status: 'SUCCESS', amount: 1000, transactionId: 't1', code: 200 });
    expect(r.status).toBe(200); expect(r.body).toEqual({ transactionId: 't1', responseCode: 200 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PENDING');
  });
  it('liste d’adresses IP : un appel depuis une autre adresse est refusé (403)', async () => {
    const { row } = await pending();
    const e = env as { MYPVIT_WEBHOOK_ALLOWED_IPS: string };
    const old = e.MYPVIT_WEBHOOK_ALLOWED_IPS;
    e.MYPVIT_WEBHOOK_ALLOWED_IPS = '203.0.113.9';
    try {
      const r = await settle(row.reference!, 'SUCCESS', { amount: 1000 });
      expect(r.status).toBe(403);
      expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PENDING');
      e.MYPVIT_WEBHOOK_ALLOWED_IPS = '127.0.0.1, ::1';
      expect((await settle(row.reference!, 'SUCCESS', { amount: 1000 })).status).toBe(200);
      expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
    } finally { e.MYPVIT_WEBHOOK_ALLOWED_IPS = old; }
  });
  it('un webhook ne crée jamais d’argent : sans achat en attente il ne change rien (aucune notification de vente)', async () => {
    const creator = await creatorSignedIn(1);
    await settle('M000000000000', 'SUCCESS', { amount: 5000 });
    expect(await prisma.messagePurchase.count()).toBe(0);
    expect(await prisma.notification.count({ where: { userId: creator.user.id } })).toBe(0);
  });
});

describe('rapprochement des paiements restés PENDING', () => {
  it('trop récent : on n’interroge pas encore le prestataire', async () => {
    const { row } = await pending();
    await age(row.id, 60);
    expect(await reconcilePurchases()).toMatchObject({ checked: 0 });
    expect(memPay.checks).toHaveLength(0);
  });
  it('le prestataire répond SUCCESS : PAID + notification du créateur ; FAILED : FAILED (réessayable)', async () => {
    const a = await pending();
    await age(a.row.id, 200);
    memPay.setStatus(a.row.reference!, 'SUCCESS');
    expect(await reconcilePurchases()).toMatchObject({ checked: 1, paid: 1 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
    expect(await prisma.notification.count({ where: { userId: a.creator.user.id, type: 'MESSAGE_PURCHASED' } })).toBe(1);
    expect(await reconcilePurchases()).toMatchObject({ checked: 0 }); // idempotent
  });
  it('FAILED chez le prestataire : échec définitif, nouvel essai possible', async () => {
    const a = await pending();
    await age(a.row.id, 200);
    memPay.setStatus(a.row.reference!, 'FAILED');
    expect(await reconcilePurchases()).toMatchObject({ failed: 1 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('FAILED');
    expect((await api().post(`${M}/${a.messageId}/unlock`).set(a.fan.auth).send(PAY)).status).toBe(202);
  });
  it('réponse inconnue : PENDING conservé tant que le délai de vérification n’est pas dépassé ; au-delà : REVIEW (jamais FAILED)', async () => {
    const a = await pending();
    await age(a.row.id, 200);
    expect(await reconcilePurchases()).toMatchObject({ checked: 1, unknown: 1, review: 0 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PENDING');
    await age(a.row.id, env.PAYMENT_REVIEW_AFTER_SECONDS + 10);
    expect(await reconcilePurchases()).toMatchObject({ review: 1 });
    expect(await prisma.messagePurchase.findFirstOrThrow()).toMatchObject({ status: 'REVIEW', reviewReason: 'TIMEOUT' });
    const blocked = await api().post(`${M}/${a.messageId}/unlock`).set(a.fan.auth).send(PAY);
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('PAYMENT_UNDER_REVIEW');
    expect(memPay.requests).toHaveLength(1); // aucun second débit possible
  });
  it('un achat REVIEW (délai) se résout seul quand l’état se précise, ou par un callback tardif', async () => {
    const a = await pending();
    await age(a.row.id, env.PAYMENT_REVIEW_AFTER_SECONDS + 10);
    await reconcilePurchases();
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('REVIEW');
    memPay.setStatus(a.row.reference!, 'SUCCESS');
    expect(await reconcilePurchases()).toMatchObject({ paid: 1 });
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
  });
  it('un callback SUCCESS qui arrive pendant le rapprochement ne double rien (une seule notification)', async () => {
    const a = await pending();
    await age(a.row.id, 200);
    memPay.setStatus(a.row.reference!, 'SUCCESS');
    await Promise.all([reconcilePurchases(), settle(a.row.reference!, 'SUCCESS', { amount: 1000 }), reconcilePurchases()]);
    expect((await prisma.messagePurchase.findFirstOrThrow()).status).toBe('PAID');
    expect(await prisma.notification.count({ where: { userId: a.creator.user.id, type: 'MESSAGE_PURCHASED' } })).toBe(1);
  });
});

describe('client MyPVit (HTTP simulé)', () => {
  const e = env as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { saved[k] = e[k]; e[k] = v; };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let calls: { url: string; init: RequestInit }[] = [];
  const stub = (handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init, calls.length); }));
  };
  const P = { amount: 1000, phone: '060123456', reference: 'MREF000000001', operator: 'AIRTEL_MONEY' as const, freeInfo: 'Message payant' };

  beforeEach(() => {
    __resetMypvitState();
    set('MYPVIT_BASE_URL', 'https://mypvit.test'); set('MYPVIT_API_PASSWORD', 'pw'); set('MYPVIT_URLCODE_RENEW_SECRET', 'RENEW'); set('MYPVIT_URLCODE_REST', 'REST');
    set('MYPVIT_URLCODE_STATUS', 'STATUS'); set('MYPVIT_CALLBACK_URL_CODE', 'CB'); set('MYPVIT_RECEPTION_URL_CODE', 'RECEP'); set('MYPVIT_ACCOUNT_AIRTEL', 'ACC_AIRTEL'); set('MYPVIT_ACCOUNT_MOOV', 'ACC_MOOV');
  });
  afterEach(() => { vi.unstubAllGlobals(); for (const [k, v] of Object.entries(saved)) e[k] = v; });

  const happy = (rest: () => Response) => (url: string) => (url.includes('/renew-secret') ? json(200, { secret: 'SEC1', expires_in: 3600, operation_account_code: 'ACC_AIRTEL' }) : rest());

  it('paiement accepté : demande conforme (X-Secret, compte, opérateur, référence, callback, frais à la charge du client) et référence prestataire', async () => {
    stub(happy(() => json(200, { status: 'PENDING', reference_id: 'PV123' })));
    expect(await initiatePayment(P)).toEqual({ status: 'ACCEPTED', providerRef: 'PV123' });
    const rest = calls.find((c) => c.url.endsWith('/v2/REST/rest'))!;
    expect((rest.init.headers as Record<string, string>)['X-Secret']).toBe('SEC1');
    expect(JSON.parse(rest.init.body as string)).toMatchObject({ amount: 1000, transaction_type: 'PAYMENT', operator_code: 'AIRTEL_MONEY', reference: 'MREF000000001', customer_account_number: '060123456', merchant_operation_account_code: 'ACC_AIRTEL', callback_url_code: 'CB', owner_charge: 'CUSTOMER', service: 'RESTFUL' });
    const renew = calls.find((c) => c.url.includes('/renew-secret'))!;
    expect(String(renew.init.body)).toContain('receptionUrlCode=RECEP');
  });
  it('la clé secrète est mise en cache (un seul renouvellement pour deux paiements)', async () => {
    stub(happy(() => json(200, { status: 'PENDING', reference_id: 'PV' })));
    await initiatePayment(P); await initiatePayment({ ...P, reference: 'MREF000000002' });
    expect(calls.filter((c) => c.url.includes('/renew-secret'))).toHaveLength(1);
  });
  it('clé expirée (401) : un seul renouvellement puis nouvel essai', async () => {
    let rest = 0;
    stub((url) => (url.includes('/renew-secret') ? json(200, { secret: `SEC${calls.length}`, expires_in: 3600 }) : ++rest === 1 ? json(401, {}) : json(200, { status: 'PENDING', reference_id: 'PV9' })));
    expect(await initiatePayment(P)).toEqual({ status: 'ACCEPTED', providerRef: 'PV9' });
    expect(calls.filter((c) => c.url.includes('/renew-secret'))).toHaveLength(2);
  });
  it('refus net (HTTP 4xx avec corps) : REJECTED, aucun nouvel essai automatique', async () => {
    stub(happy(() => json(400, { status_code: 'E42', message: 'Solde insuffisant' })));
    expect(await initiatePayment(P)).toEqual({ status: 'REJECTED', code: 'E42', message: 'Solde insuffisant' });
    expect(calls.filter((c) => c.url.endsWith('/rest'))).toHaveLength(1);
  });
  it('sort inconnu : HTTP 5xx, réseau coupé ou corps illisible → UNCERTAIN (jamais REJECTED)', async () => {
    stub(happy(() => json(503, { message: 'oops' })));
    expect(await initiatePayment(P)).toEqual({ status: 'UNCERTAIN' });
    __resetMypvitState();
    stub((url) => { if (url.includes('/renew-secret')) return json(200, { secret: 'S', expires_in: 3600 }); throw new TypeError('network'); });
    expect(await initiatePayment(P)).toEqual({ status: 'UNCERTAIN' });
    __resetMypvitState();
    stub(happy(() => new Response('<html>', { status: 200 })));
    expect(await initiatePayment(P)).toEqual({ status: 'UNCERTAIN' });
  });
  it('clé secrète indisponible (rien envoyé) : exception AppError 502, aucune demande de paiement', async () => {
    stub(() => json(500, {}));
    await expect(initiatePayment(P)).rejects.toMatchObject({ status: 502, code: 'PAYMENT_PROVIDER_ERROR' });
    expect(calls.filter((c) => c.url.endsWith('/rest'))).toHaveLength(0);
  });
  it('clé secrète livrée par webhook (compte précisé ou repli sur la plus ancienne demande)', async () => {
    stub((url) => {
      if (url.includes('/renew-secret')) { setTimeout(() => receiveSecretFromWebhook('SEC_WH', 3600, 'ACC_AIRTEL'), 10); return json(200, {}); }
      return json(200, { status: 'PENDING', reference_id: 'PVWH' });
    });
    expect(await initiatePayment(P)).toEqual({ status: 'ACCEPTED', providerRef: 'PVWH' });
    expect((calls.find((c) => c.url.endsWith('/rest'))!.init.headers as Record<string, string>)['X-Secret']).toBe('SEC_WH');
    __resetMypvitState();
    stub((url) => {
      if (url.includes('/renew-secret')) { setTimeout(() => receiveSecretFromWebhook('SEC_FALLBACK', 3600, null), 10); return json(200, {}); }
      return json(200, { status: 'PENDING', reference_id: 'PVWH2' });
    });
    expect((await initiatePayment(P)).status).toBe('ACCEPTED');
    expect((calls.find((c) => c.url.endsWith('/rest'))!.init.headers as Record<string, string>)['X-Secret']).toBe('SEC_FALLBACK');
  });
  it('une clé reçue par webhook sans demande en attente est ignorée (ne pollue pas le cache)', async () => {
    receiveSecretFromWebhook('INTRUS', 3600, null);
    stub(happy(() => json(200, { status: 'PENDING', reference_id: 'PV' })));
    await initiatePayment(P);
    expect((calls.find((c) => c.url.endsWith('/rest'))!.init.headers as Record<string, string>)['X-Secret']).toBe('SEC1');
  });
  it('API de statut : SUCCESS / FAILED / PENDING reconnus ; réponse ambiguë, absente ou en erreur → null (jamais de supposition) ; sans code d’URL → null sans appel', async () => {
    stub(happy(() => json(200, { status: 'success' })));
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBe('SUCCESS');
    stub(happy(() => json(200, { transaction_status: 'FAILED' })));
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBe('FAILED');
    stub(happy(() => json(200, { status: 'PROCESSING?' })));
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBeNull();
    stub(happy(() => json(200, {})));
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBeNull();
    stub(() => { throw new Error('down'); });
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBeNull();
    e.MYPVIT_URLCODE_STATUS = undefined;
    stub(happy(() => json(200, { status: 'SUCCESS' })));
    expect(await checkTransactionStatus('R1', 'AIRTEL_MONEY')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
