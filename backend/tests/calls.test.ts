import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/db';
import { sweepCalls } from '../src/modules/calls/calls.service';
import { api, creatorSignedIn, resetDb, settle, signedIn } from './helpers';

// Présence : tout le monde est en ligne, sauf ceux qu'un test passe hors ligne.
const presence = vi.hoisted(() => ({ offline: new Set<string>() }));
vi.mock('../src/realtime/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/realtime/realtime')>()),
  isUserOnline: (userId: string) => !presence.offline.has(userId),
}));

beforeEach(async () => {
  await resetDb();
  presence.offline.clear();
});

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
type Kind = 'AUDIO' | 'VIDEO';
const C = '/api/calls';
const PHONE = '077123456';
const ago = (ms: number) => new Date(Date.now() - ms);
const row = (id: string) => prisma.call.findUniqueOrThrow({ where: { id } });
const act = (who: S, id: string, what: 'accept' | 'decline' | 'cancel' | 'end') => api().post(`${C}/${id}/${what}`).set(who.auth).send({});
const setSettings = (creator: S, body: Record<string, unknown>) => api().put(`${C}/me/settings`).set(creator.auth).send(body);
const request = (caller: S, creator: S, type: Kind = 'AUDIO') => api().post(C).set(caller.auth).send({ calleeId: creator.user.id, type });

/** Créateur prêt à recevoir des appels : 500 F la minute en audio, 1 000 F en vidéo, 30 minutes au plus. */
async function openCreator(n = 1) {
  const c = await creatorSignedIn(n);
  const r = await setSettings(c, { pricingMode: 'PER_MINUTE', audioPrice: 500, videoPrice: 1000, maxDurationMinutes: 30, access: 'EVERYONE', isAvailable: true });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return c;
}
/** Solde de minutes posé directement (l'achat est couvert par son propre test). */
async function seedMinutes(buyer: S, creator: S, kind: Kind, seconds: number) {
  const where = { userId_creatorId_kind: { userId: buyer.user.id, creatorId: creator.user.id, kind } };
  await prisma.callMinuteAccount.upsert({ where, create: { userId: buyer.user.id, creatorId: creator.user.id, kind, balanceSeconds: seconds }, update: { balanceSeconds: seconds } });
}
async function balance(buyer: S, creator: S, kind: Kind = 'AUDIO') {
  const acc = await prisma.callMinuteAccount.findUnique({ where: { userId_creatorId_kind: { userId: buyer.user.id, creatorId: creator.user.id, kind } } });
  return acc?.balanceSeconds ?? 0;
}
/** Appel qui sonne : la demande suffit, il n'y a plus de paiement. */
async function ringing(caller: S, creator: S, type: Kind = 'AUDIO') {
  const r = await request(caller, creator, type);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.call.id as string;
}
async function active(caller: S, creator: S) {
  const id = await ringing(caller, creator);
  const r = await act(creator, id, 'accept');
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return id;
}

describe('appels payés en minutes', () => {
  it('sans minutes : refus 402 NO_MINUTES, aucun appel créé', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const r = await request(a, c);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('NO_MINUTES');
    expect(await prisma.call.count()).toBe(0);
  });

  it('créateur hors ligne : refus 409 CREATOR_OFFLINE, rien ne sonne', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    presence.offline.add(c.user.id);
    const r = await request(a, c);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CREATOR_OFFLINE');
    expect(await prisma.call.count()).toBe(0);
  });

  it('avec des minutes : l’appel sonne tout de suite, sans paiement ni débit', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const r = await request(a, c);
    expect(r.status).toBe(201);
    expect(r.body.call.status).toBe('RINGING');
    expect((await row(r.body.call.id)).reference).toBeNull();
    expect(await balance(a, c)).toBe(300);
  });

  it('un client ne peut avoir qu’un seul appel à la fois', async () => {
    const a = await signedIn(1); const c = await openCreator(2); const c2 = await openCreator(3);
    await seedMinutes(a, c, 'AUDIO', 600); await seedMinutes(a, c2, 'AUDIO', 600);
    await ringing(a, c);
    const r = await request(a, c2);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CALL_IN_PROGRESS');
  });

  it('audio et vidéo sont deux comptes distincts', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const r = await request(a, c, 'VIDEO');
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('NO_MINUTES');
  });

  it('décroché puis raccroché : seul le temps passé est débité, le reste reste sur le compte', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(90_000) } });
    expect((await act(a, id, 'end')).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'ENDED', endReason: 'HANGUP', actualSeconds: 90, consumedAmount: 750, commissionAmount: 150, creatorAmount: 600, refundAmount: 0 });
    expect(await balance(a, c)).toBe(210);
    expect(await prisma.callMinuteEntry.findFirst({ where: { sourceId: id } })).toMatchObject({ type: 'CALL_DEBIT', seconds: -90, balanceAfter: 210 });
  });

  it('le temps maximal est le solde : l’appel se termine seul à épuisement', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 120);
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(130_000), endsAt: ago(10_000) } });
    await sweepCalls();
    expect(await row(id)).toMatchObject({ status: 'ENDED', endReason: 'MAX_DURATION', actualSeconds: 120 });
    expect(await balance(a, c)).toBe(0);
  });

  it('le revenu du créateur n’est comptabilisé que pour les minutes consommées', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const id = await active(a, c);
    await prisma.call.update({ where: { id }, data: { answeredAt: ago(60_000) } });
    await act(a, id, 'end');
    expect(await prisma.creatorEarning.findFirst({ where: { source: 'PAID_CALL', sourceId: id } })).not.toBeNull();
  });

  it('appel refusé par le créateur : aucun débit', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const id = await ringing(a, c);
    expect((await act(c, id, 'decline')).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'DECLINED', consumedAmount: 0 });
    expect(await balance(a, c)).toBe(300);
  });

  it('sonnerie expirée : appel manqué, aucun débit', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const id = await ringing(a, c);
    await prisma.call.update({ where: { id }, data: { ringExpiresAt: ago(1000) } });
    await sweepCalls();
    expect(await row(id)).toMatchObject({ status: 'MISSED', endReason: 'RING_TIMEOUT', consumedAmount: 0 });
    expect(await balance(a, c)).toBe(300);
  });

  it('annulé pendant la sonnerie par l’appelant : aucun débit', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    await seedMinutes(a, c, 'AUDIO', 300);
    const id = await ringing(a, c);
    expect((await act(a, id, 'cancel')).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'CANCELLED', consumedAmount: 0 });
    expect(await balance(a, c)).toBe(300);
  });

  it('achat de minutes : la durée achetée est créditée après paiement, puis utilisable', async () => {
    const a = await signedIn(1); const c = await openCreator(2);
    const offers = await api().put('/api/call-minutes/offers').set(c.auth).send({ kind: 'AUDIO', offers: [{ seconds: 30 }] });
    expect(offers.status).toBe(200);
    const offer = await prisma.callMinuteOffer.findFirstOrThrow({ where: { creatorId: c.user.id, kind: 'AUDIO' } });
    const buy = await api().post('/api/call-minutes/purchases').set(a.auth).send({ creatorId: c.user.id, offerId: offer.id, operator: 'AIRTEL_MONEY', phone: PHONE });
    expect(buy.status).toBe(202);
    const purchase = await prisma.callMinutePurchase.findFirstOrThrow({ where: { userId: a.user.id } });
    expect((await settle(purchase.reference)).status).toBe(200);
    expect(await balance(a, c)).toBe(30);
  });
});
