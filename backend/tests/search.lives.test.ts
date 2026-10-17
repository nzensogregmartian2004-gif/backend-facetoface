import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

// Écrit, NON EXÉCUTÉ dans l'environnement de travail (pas de moteur Prisma disponible hors ligne).
// Le seuil d'abonnés pour lancer un Live (25 par défaut) est abaissé pour ces tests de recherche : ce n'est pas l'objet testé.
beforeEach(async () => {
  await resetDb();
  await prisma.appConfig.upsert({
    where: { key: 'LIVES.CREATE_MIN_FOLLOWERS' },
    create: { key: 'LIVES.CREATE_MIN_FOLLOWERS', value: 0, type: 'INTEGER', description: 'test', defaultValue: 25, category: 'LIVES' },
    update: { value: 0, enabled: true },
  });
});

type S = { user: { id: string; username: string }; auth: { Authorization: string } };

const createLive = async (host: S, title: string, access: 'EVERYONE' | 'SUBSCRIBERS' = 'EVERYONE', visibility: 'PUBLIC' | 'UNLISTED' = 'PUBLIC') => {
  const r = await api().post('/api/live').set(host.auth).send({ title, visibility, access });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.live.id as string;
};

const searchLives = (viewer: S, q?: string) => api().get('/api/search').query({ type: 'lives', ...(q ? { q } : {}) }).set(viewer.auth);
const idsOf = (body: { items: { id: string }[] }) => body.items.map((x) => x.id);

describe('recherche serveur des Lives', () => {
  it('trouve un Live public par son titre, programmé ou en cours', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const liveId = await createLive(host, 'Cuisine gabonaise en direct');
    const r = await searchLives(viewer, 'gabonaise');
    expect(r.status).toBe(200);
    expect(idsOf(r.body)).toContain(liveId);
  });

  it('ne renvoie ni les Lives réservés aux abonnés, ni les Lives non listés', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const privateId = await createLive(host, 'Réservé abonnés', 'SUBSCRIBERS');
    const unlistedId = await createLive(host, 'Non listé', 'EVERYONE', 'UNLISTED');
    const r = await searchLives(viewer);
    expect(idsOf(r.body)).not.toContain(privateId);
    expect(idsOf(r.body)).not.toContain(unlistedId);
  });

  it('exclut les hôtes bloqués dans les deux sens', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const liveId = await createLive(host, 'Live bloqué');
    await api().post(`/api/users/${host.user.id}/block`).set(viewer.auth).send({});
    const r = await searchLives(viewer, 'bloqué');
    expect(idsOf(r.body)).not.toContain(liveId);
  });

  it('place les Lives en cours avant les Lives programmés', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const scheduledId = await createLive(host, 'Programmé test');
    const liveNowId = await createLive(host, 'En cours test');
    await prisma.live.update({ where: { id: liveNowId }, data: { status: 'LIVE', startedAt: new Date() } });
    const r = await searchLives(viewer, 'test');
    const ids = idsOf(r.body);
    expect(ids.indexOf(liveNowId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(liveNowId)).toBeLessThan(ids.indexOf(scheduledId));
  });

  it('un mot-clé sans résultat renvoie une liste vide', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    await createLive(host, 'Autre sujet');
    const r = await searchLives(viewer, 'zzzintrouvable');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});
