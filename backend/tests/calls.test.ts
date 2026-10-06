import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { reconcileCallPayments } from '../src/modules/calls/calls.settlement';
import { sweepCalls } from '../src/modules/calls/calls.service';
import { api, creatorSignedIn, memCalls, memPay, resetDb, settle, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const C = '/api/calls';
const PHONE = '077123456';
const ago = (ms: number) => new Date(Date.now() - ms);

const setSettings = (creator: S, body: Record<string, unknown>) => api().put(`${C}/me/settings`).set(creator.auth).send(body);
/** Créateur prêt à recevoir des appels : 500 FCFA/min en audio, 1 000 en vidéo, 30 min maximum. */
async function openCreator(n = 1, over: Record<string, unknown> = {}) {
  const c = await creatorSignedIn(n);
  const r = await setSettings(c, { pricingMode: 'PER_MINUTE', audioPriceFcfa: 500, videoPriceFcfa: 1000, maxDurationMinutes: 30, access: 'EVERYONE', isAvailable: true, ...over });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return c;
}
const request = (caller: S, creator: S, body: Record<string, unknown> = {}) =>
  api().post(C).set(caller.auth).send({ calleeId: creator.user.id, type: 'AUDIO', minutes: 10, operator: 'AIRTEL_MONEY', phone: PHONE, ...body });
const refOf = async (id: string) => (await prisma.call.findUniqueOrThrow({ where: { id } })).reference!;
const getCall = (who: S, id: string) => api().get(`${C}/${id}`).set(who.auth);
const act = (who: S, id: string, what: 'accept' | 'decline' | 'cancel' | 'end' | 'token') => api().post(`${C}/${id}/${what}`).set(who.auth).send({});
const row = (id: string) => prisma.call.findUniqueOrThrow({ where: { id } });
const follow = (a: S, b: S) => api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({});
const block = (a: S, b: S) => api().post(`/api/users/${b.user.id}/block`).set(a.auth).send({});

/** Demande payée par le VRAI webhook : l'appel sonne chez le créateur. */
async function ringing(caller: S, creator: S, body: Record<string, unknown> = {}) {
  const r = await request(caller, creator, body);
  if (r.status !== 202) throw new Error(JSON.stringify(r.body));
  const id = r.body.call.id as string;
  expect((await settle(await refOf(id))).status).toBe(200);
  return id;
}
async function active(caller: S, creator: S, body: Record<string, unknown> = {}) {
  const id = await ringing(caller, creator, body);
  const r = await act(creator, id, 'accept');
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return id;
}

describe('réglages d’appel du créateur', () => {
  it('seul un créateur peut les lire et les modifier (403 sinon)', async () => {
    const u = await signedIn(1);
    expect((await api().get(`${C}/me/settings`).set(u.auth)).status).toBe(403);
    expect((await setSettings(u, { isAvailable: false })).status).toBe(403);
    expect((await api().get(`${C}/me/settings`)).status).toBe(401);
  });
  it('valeurs par défaut : indisponible, aucun prix ; mise à jour partielle conservée', async () => {
    const c = await creatorSignedIn(1);
    const g = await api().get(`${C}/me/settings`).set(c.auth);
    expect(g.body.settings).toMatchObject({ pricingMode: 'PER_MINUTE', audioPriceFcfa: null, videoPriceFcfa: null, isAvailable: false, access: 'EVERYONE' });
    expect((await setSettings(c, { audioPriceFcfa: 700 })).body.settings).toMatchObject({ audioPriceFcfa: 700, videoPriceFcfa: null, isAvailable: false });
    expect((await setSettings(c, { isAvailable: true })).body.settings).toMatchObject({ audioPriceFcfa: 700, isAvailable: true });
    expect((await setSettings(c, { videoPriceFcfa: null })).body.settings).toMatchObject({ audioPriceFcfa: 700, videoPriceFcfa: null });
  });
  it('refuse : prix hors bornes, durée trop longue, disponibilité sans prix, corps vide ou inconnu', async () => {
    const c = await creatorSignedIn(1);
    expect((await setSettings(c, { audioPriceFcfa: 5 })).status).toBe(400);
    expect((await setSettings(c, { audioPriceFcfa: 99_999_999 })).status).toBe(400);
    expect((await setSettings(c, { audioPriceFcfa: 1.5 })).status).toBe(400);
    expect((await setSettings(c, { maxDurationMinutes: 100_000 })).status).toBe(400);
    const none = await setSettings(c, { isAvailable: true });
    expect(none.status).toBe(400); expect(none.body.error.code).toBe('NO_CALL_PRICE');
    expect((await setSettings(c, {})).status).toBe(400);
    expect((await setSettings(c, { commissionBps: 0 })).status).toBe(400);
    expect(await prisma.creatorCallSettings.count()).toBe(0);
  });
  it('GET /settings publie les bornes et l’état des appels', async () => {
    const u = await signedIn(1);
    const r = await api().get(`${C}/settings`).set(u.auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, limits: { minPriceFcfa: 100 }, ringSeconds: 45, commissionBps: 2000 });
  });
});

describe('offre d’appel d’un créateur', () => {
  it('indisponible tant que le créateur n’a pas ouvert les appels ; puis tarifs visibles', async () => {
    const a = await signedIn(1); const c = await creatorSignedIn(2);
    const off = await api().get(`${C}/creators/${c.user.id}/offer`).set(a.auth);
    expect(off.status).toBe(200); expect(off.body).toMatchObject({ canCall: false, offer: null, reason: { code: 'CREATOR_UNAVAILABLE' } });
    await setSettings(c, { audioPriceFcfa: 500, isAvailable: true });
    const on = await api().get(`${C}/creators/${c.user.id}/offer`).set(a.auth);
    expect(on.body).toMatchObject({ canCall: true, reason: null, offer: { pricingMode: 'PER_MINUTE', audioPriceFcfa: 500, videoPriceFcfa: null, busy: false } });
  });
  it('404 pour un compte non créateur, soi-même ou un blocage ; accès « abonnés » expliqué', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await openCreator(3, { access: 'FOLLOWERS' });
    expect((await api().get(`${C}/creators/${b.user.id}/offer`).set(a.auth)).status).toBe(404);
    expect((await api().get(`${C}/creators/${c.user.id}/offer`).set(c.auth)).status).toBe(400);
    expect((await api().get(`${C}/creators/${c.user.id}/offer`).set(a.auth)).body.reason.code).toBe('CALL_FOLLOWERS_ONLY');
    await follow(a, c);
    expect((await api().get(`${C}/creators/${c.user.id}/offer`).set(a.auth)).body.canCall).toBe(true);
    await block(a, c);
    expect((await api().get(`${C}/creators/${c.user.id}/offer`).set(a.auth)).status).toBe(404);
  });
});

describe('demande d’appel et paiement', () => {
  it('calcule le prix côté serveur, lance le paiement (202) et ne fait PAS sonner le créateur avant PAID', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c, { minutes: 10 });
    expect(r.status).toBe(202);
    expect(r.body.call).toMatchObject({ direction: 'OUTGOING', status: 'AWAITING_PAYMENT', type: 'AUDIO', payment: { status: 'PENDING' }, money: { prepaidFcfa: 5000 } });
    expect(JSON.stringify(r.body)).not.toContain('reference');
    expect(memPay.requests).toHaveLength(1);
    expect(memPay.requests[0]).toMatchObject({ amountFcfa: 5000, operator: 'AIRTEL_MONEY' });
    expect(memPay.requests[0].reference.length).toBeLessThanOrEqual(13);
    expect(memPay.requests[0].reference.startsWith('C')).toBe(true);
    // le créateur ne voit ni l'appel, ni sonnerie
    expect((await getCall(c, r.body.call.id)).status).toBe(404);
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
    expect((await api().get(C).set(c.auth)).body.items).toEqual([]);
    // numéro jamais conservé en entier
    const saved = await row(r.body.call.id);
    expect(saved.payerPhoneHint).toBe('3456'); expect(JSON.stringify(saved)).not.toContain(PHONE);
  });
  it('vidéo et tarif par session : prix de la session, durée = durée maximale', async () => {
    const a = await signedIn(1); const c = await openCreator(2, { pricingMode: 'PER_SESSION', videoPriceFcfa: 8000, maxDurationMinutes: 20 });
    const r = await request(a, c, { type: 'VIDEO', minutes: 3 });
    expect(r.status).toBe(202);
    expect(r.body.call).toMatchObject({ pricingMode: 'PER_SESSION', requestedMinutes: 20, money: { prepaidFcfa: 8000 } });
    expect(memPay.requests[0].amountFcfa).toBe(8000);
  });
  it('refuse : soi-même, compte non créateur, indisponible, type non proposé, durée ou montant trop élevé, corps invalide', async () => {
    const a = await signedIn(1); const plain = await signedIn(2); const closed = await creatorSignedIn(3); const c = await openCreator(4, { videoPriceFcfa: null });
    expect((await request(a, a)).status).toBe(400); // soi-même
    expect((await request(c, c)).status).toBe(400);
    expect((await request(a, plain)).status).toBe(404);
    const un = await request(a, closed);
    expect(un.status).toBe(403); expect(un.body.error.code).toBe('CREATOR_UNAVAILABLE');
    const ty = await request(a, c, { type: 'VIDEO' });
    expect(ty.status).toBe(403); expect(ty.body.error.code).toBe('CALL_TYPE_UNAVAILABLE');
    expect((await request(a, c, { minutes: 31 })).body.error.code).toBe('INVALID_MINUTES');
    expect((await request(a, c, { minutes: 0 })).status).toBe(400);
    expect((await request(a, c, { price: 1 })).status).toBe(400); // le client n'envoie jamais de prix
    expect((await request(a, c, { operator: 'ORANGE' })).status).toBe(400);
    expect((await request(a, c, { phone: 'abc' })).status).toBe(400);
    expect(await prisma.call.count()).toBe(0);
    expect(memPay.requests).toHaveLength(0);
  });
  it('minutes par défaut = 5 (ou la durée maximale si elle est plus courte)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await api().post(C).set(a.auth).send({ calleeId: c.user.id, type: 'AUDIO', operator: 'MOOV_MONEY', phone: PHONE });
    expect(r.body.call).toMatchObject({ requestedMinutes: 5, money: { prepaidFcfa: 2500 } });
  });
  it('un blocage (dans un sens ou l’autre) rend le créateur introuvable', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await block(c, a);
    expect((await request(a, c)).status).toBe(404);
    expect(memPay.requests).toHaveLength(0);
  });
  it('accès « abonnés » : refusé tant que l’appelant ne suit pas le créateur', async () => {
    const a = await signedIn(1); const c = await openCreator(2, { access: 'FOLLOWERS' });
    const no = await request(a, c);
    expect(no.status).toBe(403); expect(no.body.error.code).toBe('CALL_FOLLOWERS_ONLY');
    await follow(a, c);
    expect((await request(a, c)).status).toBe(202);
  });
  it('un double clic ne crée qu’une demande ; une seule demande en cours par appelant', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const d = await openCreator(3);
    const [r1, r2] = await Promise.all([request(a, c), request(a, c)]);
    expect([r1.status, r2.status].sort()).toEqual([202, 409]);
    expect(await prisma.call.count()).toBe(1);
    const other = await request(a, d);
    expect(other.status).toBe(409); expect(other.body.error.code).toBe('CALL_IN_PROGRESS');
    expect(memPay.requests).toHaveLength(1);
  });
  it('paiement refusé net (402) : aucun débit, appel abandonné, nouvelle demande possible', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    memPay.rejectNext();
    const r = await request(a, c);
    expect(r.status).toBe(402); expect(r.body.error.code).toBe('PAYMENT_FAILED');
    expect(await prisma.call.findFirstOrThrow()).toMatchObject({ status: 'PAYMENT_FAILED', paymentStatus: 'FAILED' });
    expect((await request(a, c)).status).toBe(202);
  });
  it('prestataire injoignable (502) : rien n’est parti, appel abandonné', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    memPay.notSentNext();
    expect((await request(a, c)).status).toBe(502);
    expect(await prisma.call.findFirstOrThrow()).toMatchObject({ status: 'PAYMENT_FAILED', paymentStatus: 'FAILED' });
  });
  it('réponse perdue : le paiement reste PENDING, aucun nouvel essai possible (pas de double débit)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    memPay.uncertainNext();
    const r = await request(a, c);
    expect(r.status).toBe(202);
    expect((await row(r.body.call.id)).paymentStatus).toBe('PENDING');
    const again = await request(a, c);
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('CALL_IN_PROGRESS');
    expect(memPay.requests).toHaveLength(1);
  });
});

describe('règlement du paiement (webhook)', () => {
  it('SUCCESS : l’appel sonne chez le créateur, qui le voit dans « entrants » ; le webhook rejoué est sans effet', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c);
    const saved = await row(id);
    expect(saved).toMatchObject({ status: 'RINGING', paymentStatus: 'PAID' });
    expect(saved.ringExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const inc = await api().get(`${C}/incoming`).set(c.auth);
    expect(inc.body.items).toHaveLength(1);
    expect(inc.body.items[0]).toMatchObject({ id, direction: 'INCOMING', status: 'RINGING', type: 'AUDIO' });
    expect(inc.body.items[0].other.username).toBe(a.user.username);
    expect(inc.body.items[0].money.prepaidFcfa).toBeUndefined(); // le créateur ne voit pas le prépayé du payeur
    const paidAt = (await row(id)).paidAt!.getTime();
    await settle(saved.reference!); // rejoué par le prestataire : sans effet
    expect(await row(id)).toMatchObject({ status: 'RINGING', paymentStatus: 'PAID' });
    expect((await row(id)).paidAt!.getTime()).toBe(paidAt);
  });
  it('FAILED : appel abandonné, le créateur n’entend jamais parler de la demande', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    await settle(await refOf(r.body.call.id), 'FAILED');
    expect(await row(r.body.call.id)).toMatchObject({ status: 'PAYMENT_FAILED', paymentStatus: 'FAILED' });
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
    expect((await request(a, c)).status).toBe(202); // nouvel essai possible : l'échec est définitif
  });
  it('tout statut autre que SUCCESS est un échec ; référence inconnue : ignorée sans erreur', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    await settle(await refOf(r.body.call.id), 'PENDING');
    expect((await row(r.body.call.id)).paymentStatus).toBe('FAILED');
    expect((await settle('CINCONNU00000')).status).toBe(200);
  });
  it('montant confirmé inférieur au prix : REVIEW, l’appel ne sonne pas et le payeur ne peut pas réessayer', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    await settle(await refOf(r.body.call.id), 'SUCCESS', { amount: 100 });
    expect(await row(r.body.call.id)).toMatchObject({ paymentStatus: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', status: 'PAYMENT_FAILED' });
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
    const retry = await request(a, c);
    expect(retry.status).toBe(409); expect(retry.body.error.code).toBe('PAYMENT_UNDER_REVIEW');
    // une confirmation correcte ultérieure résout la vérification, mais le paiement est trop tardif pour faire sonner l'appel : remboursement dû
    await prisma.call.update({ where: { id: r.body.call.id }, data: { initiatedAt: ago(10 * 60_000) } });
    await settle(await refOf(r.body.call.id), 'SUCCESS', { amount: 5000 });
    expect(await row(r.body.call.id)).toMatchObject({ paymentStatus: 'PAID', status: 'MISSED', endReason: 'STALE_PAYMENT', refundFcfa: 5000, refundStatus: 'DUE', consumedFcfa: 0 });
  });
  it('succès tardif sur un paiement déjà échoué : REVIEW (jamais ignoré)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    const ref = await refOf(r.body.call.id);
    await settle(ref, 'FAILED');
    await settle(ref, 'SUCCESS');
    expect(await row(r.body.call.id)).toMatchObject({ paymentStatus: 'REVIEW', reviewReason: 'LATE_SUCCESS', status: 'PAYMENT_FAILED' });
  });
  it('paiement confirmé trop tard (> CALL_PAYMENT_VALID_SECONDS) : ne fait pas sonner, remboursement dû', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    await prisma.call.update({ where: { id: r.body.call.id }, data: { initiatedAt: ago(20 * 60_000) } });
    await settle(await refOf(r.body.call.id));
    expect(await row(r.body.call.id)).toMatchObject({ status: 'MISSED', endReason: 'STALE_PAYMENT', paymentStatus: 'PAID', refundFcfa: 5000, refundStatus: 'DUE', creatorFcfa: 0 });
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
  });
  it('créateur devenu occupé entre-temps : pas de sonnerie, remboursement dû ; pas de nouvelle demande vers un créateur occupé', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await openCreator(3);
    const first = await request(a, c);
    const second = await request(b, c); // accepté tant que personne n'a encore payé
    expect(second.status).toBe(202);
    await settle(await refOf(first.body.call.id));
    await settle(await refOf(second.body.call.id)); // le créateur sonne déjà pour a
    expect(await row(first.body.call.id)).toMatchObject({ status: 'RINGING' });
    expect(await row(second.body.call.id)).toMatchObject({ status: 'MISSED', endReason: 'CREATOR_BUSY', refundFcfa: 5000, refundStatus: 'DUE' });
    const third = await signedIn(4);
    const busy = await request(third, c);
    expect(busy.status).toBe(409); expect(busy.body.error.code).toBe('CREATOR_BUSY');
    expect((await api().get(`${C}/creators/${c.user.id}/offer`).set(third.auth)).body).toMatchObject({ canCall: false, reason: { code: 'CREATOR_BUSY' } });
  });
  it('deux paiements simultanés vers le même créateur : un seul sonne', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await openCreator(3);
    const r1 = await request(a, c); const r2 = await request(b, c);
    await Promise.all([refOf(r1.body.call.id).then(settle), refOf(r2.body.call.id).then(settle)]);
    const rows = await prisma.call.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.filter((x) => x.status === 'RINGING')).toHaveLength(1);
    expect(rows.filter((x) => x.status === 'MISSED' && x.refundStatus === 'DUE')).toHaveLength(1);
  });
});

describe('rapprochement des paiements d’appel', () => {
  it('interroge le prestataire : SUCCESS → l’appel sonne ; sans réponse après le délai → REVIEW (jamais d’échec automatique)', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const d = await openCreator(3);
    const r1 = await request(a, c);
    memPay.setStatus(await refOf(r1.body.call.id), 'SUCCESS');
    await prisma.call.update({ where: { id: r1.body.call.id }, data: { initiatedAt: ago(4 * 60_000) } });
    const out = await reconcileCallPayments();
    expect(out).toMatchObject({ checked: 1, paid: 1 });
    expect((await row(r1.body.call.id)).status).toBe('RINGING');

    const b = await signedIn(4);
    const r2 = await request(b, d);
    await prisma.call.update({ where: { id: r2.body.call.id }, data: { initiatedAt: ago(40 * 60_000) } });
    const out2 = await reconcileCallPayments();
    expect(out2).toMatchObject({ review: 1 });
    expect(await row(r2.body.call.id)).toMatchObject({ paymentStatus: 'REVIEW', reviewReason: 'TIMEOUT', status: 'PAYMENT_FAILED' });
  });
  it('ne touche pas un paiement trop récent', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    memPay.setStatus(await refOf(r.body.call.id), 'SUCCESS');
    expect((await reconcileCallPayments()).checked).toBe(0);
    expect((await row(r.body.call.id)).paymentStatus).toBe('PENDING');
  });
});

describe('décrocher, refuser, annuler', () => {
  it('le créateur décroche : le décompte démarre, la fin est fixée à la durée prépayée', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c, { minutes: 10 });
    const r = await act(c, id, 'accept');
    expect(r.status).toBe(200);
    expect(r.body.call).toMatchObject({ status: 'ACTIVE' });
    const saved = await row(id);
    expect(saved.endsAt!.getTime() - saved.answeredAt!.getTime()).toBe(10 * 60_000);
    expect(r.body.call.remainingSeconds).toBeGreaterThan(590);
    expect((await getCall(a, id)).body.call.status).toBe('ACTIVE'); // l'appelant le voit en sondant
  });
  it('seul le créateur appelé peut décrocher ou refuser ; seul l’appelant peut annuler', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const x = await signedIn(3);
    const id = await ringing(a, c);
    expect((await act(a, id, 'accept')).status).toBe(404);
    expect((await act(x, id, 'accept')).status).toBe(404);
    expect((await act(x, id, 'cancel')).status).toBe(404);
    expect((await act(c, id, 'cancel')).status).toBe(404);
    expect((await act(a, id, 'decline')).status).toBe(404);
    expect((await row(id)).status).toBe('RINGING');
  });
  it('le créateur refuse : rien consommé, tout est à rembourser', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c);
    const r = await act(c, id, 'decline');
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'DECLINED', endReason: 'DECLINED', consumedFcfa: 0, creatorFcfa: 0, refundFcfa: 5000, refundStatus: 'DUE' });
    expect((await act(c, id, 'accept')).status).toBe(409);
    expect((await act(c, id, 'decline')).status).toBe(409);
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
  });
  it('l’appelant annule pendant la sonnerie : remboursement dû ; pendant la validation du paiement : refusé', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const pending = await request(a, c);
    const no = await act(a, pending.body.call.id, 'cancel');
    expect(no.status).toBe(409); expect(no.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    await settle(await refOf(pending.body.call.id));
    const r = await act(a, pending.body.call.id, 'cancel');
    expect(r.status).toBe(200);
    expect(await row(pending.body.call.id)).toMatchObject({ status: 'CANCELLED', endReason: 'CANCELLED', refundFcfa: 5000, refundStatus: 'DUE' });
    expect((await act(a, pending.body.call.id, 'cancel')).status).toBe(409);
  });
  it('sonnerie expirée : appel manqué, remboursement dû (lecture, puis balayage)', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const b = await signedIn(3); const d = await openCreator(4);
    const id = await ringing(a, c);
    await prisma.call.update({ where: { id }, data: { ringExpiresAt: ago(1000) } });
    expect((await act(c, id, 'accept')).status).toBe(409); // trop tard
    expect(await row(id)).toMatchObject({ status: 'MISSED', endReason: 'RING_TIMEOUT', refundFcfa: 5000, refundStatus: 'DUE' });
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);

    const id2 = await ringing(b, d);
    await prisma.call.update({ where: { id: id2 }, data: { ringExpiresAt: ago(1000) } });
    expect((await sweepCalls()).processed).toBe(1);
    expect((await row(id2)).status).toBe('MISSED');
    expect((await sweepCalls()).processed).toBe(0);
  });
  it('un appelant bloqué après coup ne sonne plus et ne peut plus être décroché', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c);
    await block(c, a);
    expect((await api().get(`${C}/incoming`).set(c.auth)).body.items).toEqual([]);
    expect((await act(c, id, 'accept')).status).toBe(404);
  });
});

describe('fin d’appel et décompte', () => {
  it('par minute : toute minute commencée est due, le reste est à rembourser (125 s → 3 min)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c, { minutes: 10 });
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(125_000) } });
    const r = await act(a, id, 'end');
    expect(r.status).toBe(200);
    expect(r.body.call).toMatchObject({ status: 'ENDED', endReason: 'HANGUP', money: { prepaidFcfa: 5000, consumedFcfa: 1500, refundFcfa: 3500, refundStatus: 'DUE' } });
    const saved = await row(id);
    expect(saved).toMatchObject({ consumedFcfa: 1500, commissionFcfa: 300, creatorFcfa: 1200, commissionBps: 2000, refundFcfa: 3500 });
    expect(saved.actualSeconds).toBeGreaterThanOrEqual(125); expect(saved.actualSeconds).toBeLessThan(130);
    expect(saved.consumedFcfa! + saved.refundFcfa).toBe(saved.grossFcfa);
    expect(saved.commissionFcfa! + saved.creatorFcfa!).toBe(saved.consumedFcfa);
    expect(memCalls.closed).toContain(id);
    // le créateur voit sa part, pas le prépayé
    const cv = await getCall(c, id);
    expect(cv.body.call.money).toMatchObject({ consumedFcfa: 1500, creatorFcfa: 1200, commissionFcfa: 300 });
    expect(cv.body.call.money.prepaidFcfa).toBeUndefined();
  });
  it('l’un ou l’autre peut raccrocher ; raccrocher deux fois est idempotent', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(61_000) } });
    expect((await act(c, id, 'end')).status).toBe(200);
    const first = await row(id);
    expect((await act(a, id, 'end')).status).toBe(200);
    expect(await row(id)).toMatchObject({ consumedFcfa: first.consumedFcfa, endedAt: first.endedAt });
    expect((await act(await signedIn(3), id, 'end')).status).toBe(404);
  });
  it('coupure immédiate (< 10 s) : appel non facturé, remboursement intégral', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c);
    const r = await act(a, id, 'end');
    expect(r.body.call).toMatchObject({ status: 'ENDED', money: { consumedFcfa: 0, refundFcfa: 5000, refundStatus: 'DUE' } });
    expect(await row(id)).toMatchObject({ creatorFcfa: 0, commissionFcfa: 0 });
  });
  it('tarif par session : due en entier dès que l’appel a vraiment commencé', async () => {
    const a = await signedIn(1); const c = await openCreator(2, { pricingMode: 'PER_SESSION', audioPriceFcfa: 8000, maxDurationMinutes: 20 });
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(30_000) } });
    await act(c, id, 'end');
    expect(await row(id)).toMatchObject({ consumedFcfa: 8000, commissionFcfa: 1600, creatorFcfa: 6400, refundFcfa: 0, refundStatus: 'NONE' });
  });
  it('durée maximale atteinte : fin automatique à l’échéance, plafonnée au prépayé, salle fermée', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c, { minutes: 10 });
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(11 * 60_000), endsAt: ago(60_000) } });
    const r = await getCall(a, id); // lecture : l'échéance est appliquée
    expect(r.body.call).toMatchObject({ status: 'ENDED', endReason: 'MAX_DURATION', actualSeconds: 600, money: { consumedFcfa: 5000, refundFcfa: 0, refundStatus: 'NONE' } });
    expect(memCalls.closed).toContain(id);
  });
  it('balayage : clôt les appels dont personne n’a raccroché', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c, { minutes: 5 });
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(6 * 60_000), endsAt: ago(30_000) } });
    expect((await sweepCalls()).processed).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'ENDED', endReason: 'MAX_DURATION', consumedFcfa: 2500, actualSeconds: 300 });
  });
  it('un appel non décroché ne peut pas être « raccroché » (409)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c);
    const r = await act(a, id, 'end');
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('CALL_NOT_ACTIVE');
  });
  it('un nouvel appel est possible après la fin du précédent', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c);
    expect((await request(a, c)).status).toBe(409);
    await act(a, id, 'end');
    expect((await request(a, c)).status).toBe(202);
  });
});

describe('jeton d’accès à la salle', () => {
  it('délivré aux deux participants uniquement quand l’appel est en cours, valable au plus jusqu’à la fin prépayée', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const x = await signedIn(3);
    const id = await ringing(a, c, { type: 'VIDEO', minutes: 2 });
    const early = await act(a, id, 'token');
    expect(early.status).toBe(409); expect(early.body.error.code).toBe('CALL_NOT_ACTIVE');
    expect((await act(c, id, 'token')).status).toBe(409);
    await act(c, id, 'accept');
    const ta = await act(a, id, 'token'); const tc = await act(c, id, 'token');
    expect(ta.status).toBe(200); expect(tc.status).toBe(200);
    expect(ta.body.grant).toMatchObject({ provider: 'memory', room: id, identity: a.user.id });
    expect(tc.body.grant).toMatchObject({ room: id, identity: c.user.id });
    expect(ta.body.grant.token).not.toBe(tc.body.grant.token);
    expect(memCalls.grants).toHaveLength(2);
    expect(memCalls.grants[0]).toMatchObject({ video: true });
    expect(memCalls.grants[0].ttlSeconds).toBeLessThanOrEqual(120);
    expect((await act(x, id, 'token')).status).toBe(404);
    await act(a, id, 'end');
    expect((await act(a, id, 'token')).status).toBe(409);
  });
});

describe('litige', () => {
  const dispute = (who: S, id: string, reason = 'La communication était coupée en continu.') => api().post(`${C}/${id}/dispute`).set(who.auth).send({ reason });
  it('le payeur conteste un appel facturé, une seule fois ; l’administration le traitera (étape 16)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(90_000) } });
    await act(a, id, 'end');
    expect((await dispute(c, id)).status).toBe(404);
    expect((await dispute(a, id, 'court')).status).toBe(400);
    const r = await dispute(a, id);
    expect(r.status).toBe(200); expect(r.body.call.dispute.reason).toContain('coupée');
    const again = await dispute(a, id);
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_DISPUTED');
  });
  it('impossible sur un appel non facturé, non terminé ou trop ancien', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await active(a, c);
    expect((await dispute(a, id)).body.error.code).toBe('CALL_NOT_DISPUTABLE'); // en cours
    await act(a, id, 'end'); // coupure immédiate : non facturé
    expect((await dispute(a, id)).body.error.code).toBe('CALL_NOT_DISPUTABLE');
    const id2 = await active(a, c);
    await prisma.call.update({ where: { id: id2 }, data: { answeredAt: ago(90_000) } });
    await act(a, id2, 'end');
    await prisma.call.update({ where: { id: id2 }, data: { endedAt: ago(10 * 86_400_000) } });
    expect((await dispute(a, id2)).body.error.code).toBe('DISPUTE_WINDOW_CLOSED');
  });
});

describe('historique', () => {
  it('l’appelant voit ses demandes (même non payées), le créateur seulement les appels payés ; pagination', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const first = await request(a, c); // reste AWAITING_PAYMENT
    await settle(await refOf(first.body.call.id), 'FAILED');
    const id2 = await ringing(a, c);
    await act(c, id2, 'decline');
    const id3 = await ringing(a, c);
    const mine = await api().get(C).set(a.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([id3, id2, first.body.call.id]);
    expect(mine.body.items[0].direction).toBe('OUTGOING');
    const theirs = await api().get(C).set(c.auth);
    expect(theirs.body.items.map((x: { id: string }) => x.id)).toEqual([id3, id2]);
    expect(theirs.body.items[0].direction).toBe('INCOMING');
    const p1 = await api().get(`${C}?limit=2`).set(a.auth);
    expect(p1.body.items).toHaveLength(2); expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api().get(`${C}?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set(a.auth);
    expect(p2.body.items.map((x: { id: string }) => x.id)).toEqual([first.body.call.id]);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe('sécurité et intégrité', () => {
  it('toutes les routes exigent une session ; un inconnu reçoit 404 (jamais le détail d’un appel étranger)', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const x = await signedIn(3);
    const id = await ringing(a, c);
    for (const [m, p] of [['get', C], ['get', `${C}/incoming`], ['get', `${C}/${id}`], ['post', C], ['post', `${C}/${id}/accept`], ['post', `${C}/${id}/token`]] as const) {
      expect((await api()[m](p).send({})).status).toBe(401);
    }
    expect((await getCall(x, id)).status).toBe(404);
    expect((await getCall(a, 'inconnu')).status).toBe(404);
  });
  it('un appel ne disparaît jamais en cascade : la base refuse de supprimer l’un des deux comptes (RESTRICT)', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await ringing(a, c);
    await expect(prisma.user.delete({ where: { id: a.user.id } })).rejects.toThrow();
    await expect(prisma.user.delete({ where: { id: c.user.id } })).rejects.toThrow();
    expect(await prisma.call.count()).toBe(1);
  });
  it('le webhook aiguille par préfixe de référence : une référence de message inconnue est ignorée sans toucher aux appels', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const id = await ringing(a, c);
    const ref = await refOf(id);
    expect(ref.startsWith('C')).toBe(true);
    expect((await settle('MZZZZZZZZZZZZ')).status).toBe(200); // référence de message inconnue : ignorée
    expect((await row(id)).status).toBe('RINGING');
  });
});
