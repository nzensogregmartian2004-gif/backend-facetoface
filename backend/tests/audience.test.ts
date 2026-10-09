import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const AUD = '/api/creator/audience/countries';

const follow = (follower: S, creator: S, daysAgo = 1) => prisma.follow.create({
  data: { followerId: follower.user.id, followingId: creator.user.id, createdAt: new Date(Date.now() - daysAgo * 86_400_000) },
});
const setCountry = (s: S, country: string | null) => prisma.user.update({ where: { id: s.user.id }, data: { country } });

describe('étape 5 — audience géographique', () => {
  it('un non-créateur reçoit 403', async () => {
    const user = await signedIn(1);
    expect((await api().get(AUD).set(user.auth)).status).toBe(403);
  });

  it('le créateur voit la répartition de ses abonnés, par pays, sans identité', async () => {
    const creator = await creatorSignedIn(1);
    for (let i = 0; i < 6; i++) { const f = await signedIn(10 + i); await setCountry(f, 'GA'); await follow(f, creator); }
    for (let i = 0; i < 2; i++) { const f = await signedIn(20 + i); await setCountry(f, 'CM'); await follow(f, creator); }
    const r = await api().get(AUD).set(creator.auth);
    expect(r.status).toBe(200);
    expect(r.body.countries).toEqual([expect.objectContaining({ countryCode: 'GA', followers: 6, percentage: 75 })]);
    expect(r.body.others).toEqual(expect.objectContaining({ followers: 2 }));
    expect(JSON.stringify(r.body)).not.toMatch(/user_1[0-9]|user_2[0-9]|@|"username"|"displayName"|"id":/);
  });

  it('les abonnés sans pays, les comptes suspendus et les supprimés sont traités à part ou exclus', async () => {
    const creator = await creatorSignedIn(1);
    for (let i = 0; i < 5; i++) { const f = await signedIn(10 + i); await follow(f, creator); }
    const gone = await signedIn(30); await setCountry(gone, 'GA'); await follow(gone, creator);
    await prisma.user.update({ where: { id: gone.user.id }, data: { status: 'DELETED' } });
    const r = await api().get(AUD).set(creator.auth);
    expect(r.body.unknown).toEqual(expect.objectContaining({ followers: 5 }));
    expect(r.body.totalFollowers).toBe(5);
  });

  it('le filtre de période change les chiffres : un abonné ancien n’entre pas dans la fenêtre de 7 jours', async () => {
    const creator = await creatorSignedIn(1);
    const recent = await signedIn(10); await setCountry(recent, 'GA'); await follow(recent, creator, 1);
    const old = await signedIn(11); await setCountry(old, 'GA'); await follow(old, creator, 40);
    const w7 = await api().get(`${AUD}?range=7d`).set(creator.auth);
    const w12 = await api().get(`${AUD}?range=12m`).set(creator.auth);
    expect(w7.body.totalFollowers).toBe(1);
    expect(w12.body.totalFollowers).toBe(2);
    expect(w12.body.followersAll).toBe(2);
  });

  it('un créateur ne voit que ses propres abonnés', async () => {
    const a = await creatorSignedIn(1); const b = await creatorSignedIn(2);
    const f = await signedIn(10); await setCountry(f, 'GA'); await follow(f, b);
    const r = await api().get(AUD).set(a.auth);
    expect(r.body.totalFollowers).toBe(0);
    expect(r.body.countries).toEqual([]);
  });
});
