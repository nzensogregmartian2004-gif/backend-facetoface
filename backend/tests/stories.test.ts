import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { objectStorage } from '../src/utils/objectStorage';
import { purgeExpiredStories } from '../src/modules/stories/stories.service';
import { api, memStore, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const H = 3_600_000;

/** Téléversement simulé d'un média de story : URL signée → « PUT » direct. */
async function upload(a: S, contentType = 'image/png', size = 50_000) {
  const r = await api().post('/api/stories/upload-url').set(a.auth).send({ contentType, sizeBytes: size });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  memStore.put(r.body.upload.key, size, contentType);
  return r.body.upload.key as string;
}
const publish = (a: S, key: string, extra: Record<string, unknown> = {}) => api().post('/api/stories').set(a.auth).send({ mediaKey: key, ...extra });
const storiesOf = (viewer: S, userId: string) => api().get(`/api/stories/users/${userId}`).set(viewer.auth);
const mineOf = (a: S) => api().get('/api/stories/mine').set(a.auth);
const setPrivacy = (a: S, body: Record<string, unknown>) => api().patch('/api/users/me/privacy').set(a.auth).send(body);

describe('stories', () => {
  it('réglages : activées, 24 h par défaut, durées proposées jusqu’au maximum', async () => {
    const a = await signedIn(1);
    const s = (await api().get('/api/stories/settings').set(a.auth)).body;
    expect(s).toMatchObject({ enabled: true, defaultHours: 24, maxHours: 72 });
    expect(s.hoursOptions).toContain(24);
    expect(Math.max(...s.hoursOptions)).toBeLessThanOrEqual(72);
  });

  it('publication d’une photo : 24 h par défaut, ou la durée choisie par l’auteur', async () => {
    const a = await signedIn(1);
    const r = await publish(a, await upload(a));
    expect(r.status).toBe(201);
    expect(r.body.story).toMatchObject({ mediaType: 'IMAGE', seen: false });
    expect(r.body.story.media.url).toBeTruthy();
    expect(Math.abs(new Date(r.body.story.expiresAt).getTime() - (Date.now() + 24 * H))).toBeLessThan(60_000);
    const k2 = await upload(a);
    const short = await publish(a, k2, { hours: 6, caption: 'bonjour' });
    expect(Math.abs(new Date(short.body.story.expiresAt).getTime() - (Date.now() + 6 * H))).toBeLessThan(60_000);
    expect(short.body.story.caption).toBe('bonjour');
  });

  it('durée invalide, format refusé, fichier non reçu ou mal rattaché : refus explicites', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    const key = await upload(a);
    for (const bad of [0, 100]) expect((await publish(a, key, { hours: bad })).body.error.code).toBe('INVALID_STORY_DURATION');
    const audio = await api().post('/api/stories/upload-url').set(a.auth).send({ contentType: 'audio/mp4', sizeBytes: 1000 });
    expect(audio.status).toBe(400);
    expect(audio.body.error.code).toBe('UNSUPPORTED_STORY');
    expect((await publish(b, key)).body.error.code).toBe('INVALID_MEDIA');
    const missing = await publish(a, `stories/${a.user.id}/absent.png`);
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('UPLOAD_MISSING');
  });

  it('taille maximale d’une photo de story', async () => {
    const a = await signedIn(1);
    const r = await api().post('/api/stories/upload-url').set(a.auth).send({ contentType: 'image/png', sizeBytes: 11 * 1024 * 1024 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('visibilité : profil public visible de tous ; profil privé réservé aux abonnés ; bloqué jamais', async () => {
    const author = await signedIn(1); const stranger = await signedIn(2); const follower = await signedIn(3); const blocked = await signedIn(4);
    await publish(author, await upload(author));
    expect((await storiesOf(stranger, author.user.id)).body.stories).toHaveLength(1);

    await setPrivacy(author, { profileVisibility: 'PRIVATE' });
    expect((await storiesOf(stranger, author.user.id)).body.stories).toEqual([]);
    await api().post(`/api/users/${author.user.id}/follow`).set(follower.auth).send({});
    expect((await storiesOf(follower, author.user.id)).body.stories).toHaveLength(1);

    await setPrivacy(author, { profileVisibility: 'PUBLIC' });
    await api().post(`/api/users/${blocked.user.id}/block`).set(author.auth).send({});
    expect((await storiesOf(blocked, author.user.id)).body.stories).toEqual([]);
  });

  it('vues : marquées une fois, l’auteur voit qui a vu ; l’auteur ne compte pas ses propres vues', async () => {
    const author = await signedIn(1); const viewer = await signedIn(2);
    const story = (await publish(author, await upload(author))).body.story;
    expect((await api().post(`/api/stories/${story.id}/view`).set(author.auth)).status).toBe(204);
    expect((await api().post(`/api/stories/${story.id}/view`).set(viewer.auth)).status).toBe(204);
    expect((await api().post(`/api/stories/${story.id}/view`).set(viewer.auth)).status).toBe(204);
    const seen = (await storiesOf(viewer, author.user.id)).body;
    expect(seen).toMatchObject({ allSeen: true });
    expect(seen.stories[0].seen).toBe(true);
    const mine = (await mineOf(author)).body.items[0];
    expect(mine.viewers).toHaveLength(1);
    expect(mine.viewers[0].userId).toBe(viewer.user.id);
  });

  it('suppression : seul l’auteur, et le fichier disparaît', async () => {
    const author = await signedIn(1); const other = await signedIn(2);
    const key = await upload(author);
    const story = (await publish(author, key)).body.story;
    expect((await api().delete(`/api/stories/${story.id}`).set(other.auth)).status).toBe(404);
    expect((await api().delete(`/api/stories/${story.id}`).set(author.auth)).status).toBe(204);
    expect(await objectStorage.head(key)).toBeNull();
    expect((await storiesOf(other, author.user.id)).body.stories).toEqual([]);
  });

  it('expiration : purge du fichier et de la story une fois la durée écoulée', async () => {
    const a = await signedIn(1);
    const key = await upload(a);
    const story = (await publish(a, key)).body.story;
    expect(await purgeExpiredStories()).toBe(0);
    expect(await purgeExpiredStories(new Date(Date.now() + 25 * H))).toBe(1);
    expect(await objectStorage.head(key)).toBeNull();
    expect(await prisma.story.count({ where: { id: story.id } })).toBe(0);
  });

  it('désactivées par configuration : aucune publication, aucune story affichée', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    await publish(a, await upload(a));
    await prisma.appConfig.upsert({ where: { key: 'STORIES.ENABLED' }, update: { value: false, enabled: true }, create: { key: 'STORIES.ENABLED', value: false, type: 'BOOLEAN', enabled: true, description: 'test', defaultValue: true, category: 'GENERAL' } });
    const up = await api().post('/api/stories/upload-url').set(a.auth).send({ contentType: 'image/png', sizeBytes: 1000 });
    expect(up.status).toBe(403);
    expect(up.body.error.code).toBe('STORIES_DISABLED');
    expect((await storiesOf(b, a.user.id)).body.stories).toEqual([]);
    expect((await api().get('/api/stories/settings').set(b.auth)).body.enabled).toBe(false);
  });
});
