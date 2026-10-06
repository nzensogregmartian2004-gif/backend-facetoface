import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, basePath, bodyKey, creatorSignedIn, publishedContent, resetDb, signedIn, createDraft, type Kind } from './helpers';

beforeEach(resetDb);

type Auth = { Authorization: string };
const feed = (a: Auth, tab: string, q = '') => api().get(`/api/feed/${tab}${q ? `?${q}` : ''}`).set(a);
const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);
/** Fixe la date de publication (les tests de tri ne doivent pas dépendre de l'horloge). */
const publishedAt = (kind: Kind, id: string, d: Date) => (kind === 'VIDEO' ? prisma.video.update({ where: { id }, data: { publishedAt: d } }) : prisma.short.update({ where: { id }, data: { publishedAt: d } }));
const setCounts = (kind: Kind, id: string, data: object) => (kind === 'VIDEO' ? prisma.video.update({ where: { id }, data }) : prisma.short.update({ where: { id }, data }));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe('suivi (fondation pour « Abonnements »)', () => {
  it('suit et ne suit plus, de façon idempotente', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    expect((await api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({})).status).toBe(204);
    expect((await api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({})).status).toBe(204);
    expect(await prisma.follow.count()).toBe(1);
    expect((await api().delete(`/api/users/${b.user.id}/follow`).set(a.auth)).status).toBe(204);
    expect((await api().delete(`/api/users/${b.user.id}/follow`).set(a.auth)).status).toBe(204);
    expect(await prisma.follow.count()).toBe(0);
  });

  it('refuse de se suivre soi-même, un inconnu, un compte suspendu ou un compte bloqué', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    const c = await signedIn(3);
    expect((await api().post(`/api/users/${a.user.id}/follow`).set(a.auth).send({})).body.error.code).toBe('CANNOT_TARGET_SELF');
    expect((await api().post('/api/users/inconnu/follow').set(a.auth).send({})).status).toBe(404);
    await prisma.user.update({ where: { id: c.user.id }, data: { status: 'SUSPENDED' } });
    expect((await api().post(`/api/users/${c.user.id}/follow`).set(a.auth).send({})).status).toBe(404);
    await api().post(`/api/users/${a.user.id}/block`).set(b.auth).send({});
    expect((await api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({})).status).toBe(404);
  });

  it('bloquer rompt les suivis dans les deux sens', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    await api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({});
    await api().post(`/api/users/${a.user.id}/follow`).set(b.auth).send({});
    expect(await prisma.follow.count()).toBe(2);
    await api().post(`/api/users/${b.user.id}/block`).set(a.auth).send({});
    expect(await prisma.follow.count()).toBe(0);
  });
});

describe.each<Kind>(['VIDEO', 'SHORT'])('feed %s', (kind) => {
  const type = kind === 'SHORT' ? 'short' : 'video';
  const K = bodyKey(kind);

  it('exige une authentification et un feed connu', async () => {
    expect((await api().get('/api/feed/for-you')).status).toBe(401);
    const { auth } = await signedIn(1);
    expect((await feed(auth, 'inconnu')).status).toBe(404);
    expect((await feed(auth, 'for-you', 'type=audio')).status).toBe(400);
    expect((await feed(auth, 'for-you', 'limit=0')).status).toBe(400);
    expect((await feed(auth, 'for-you', 'limit=500')).status).toBe(400);
    expect((await feed(auth, 'for-you', 'cursor=pas-un-curseur')).status).toBe(400);
  });

  it('un feed vide est une réponse valide', async () => {
    const { auth } = await signedIn(1);
    for (const tab of ['for-you', 'following', 'trending']) {
      const res = await feed(auth, tab, `type=${type}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    }
  });

  it('ne montre que du contenu publié, public, d’un auteur actif, jamais le sien ni celui d’un utilisateur bloqué', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const blockedCreator = await creatorSignedIn(3);
    const suspended = await creatorSignedIn(4);
    const mine = await creatorSignedIn(5);
    const shown = await publishedContent(creator.auth, kind, { title: 'visible' });
    await publishedContent(creator.auth, kind, { visibility: 'PRIVATE' });
    await publishedContent(creator.auth, kind, { visibility: 'UNLISTED' });
    await createDraft(creator.auth, kind);
    const fromBlocked = await publishedContent(blockedCreator.auth, kind);
    const fromSuspended = await publishedContent(suspended.auth, kind);
    await publishedContent(mine.auth, kind);
    await api().post(`/api/users/${blockedCreator.user.id}/block`).set(viewer.auth).send({});
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });
    for (const tab of ['for-you', 'trending']) {
      const res = await feed(viewer.auth, tab, `type=${type}`);
      expect(ids(res), tab).toContain(shown.id);
      expect(ids(res), tab).not.toContain(fromBlocked.id);
      expect(ids(res), tab).not.toContain(fromSuspended.id);
      expect(res.body.items.every((i: any) => i.status === 'PUBLISHED' && i.visibility === 'PUBLIC'), tab).toBe(true);
      expect(res.body.items.filter((i: any) => i.title === 'visible')).toHaveLength(1);
    }
    // l'auteur ne voit pas son propre contenu dans « Pour toi »
    const own = await feed(mine.auth, 'for-you', `type=${type}`);
    expect(own.body.items.every((i: any) => i.author.id !== mine.user.id)).toBe(true);
    // et la personne bloquée par un créateur ne voit plus ce créateur dans son feed
    const reverse = await feed(blockedCreator.auth, 'for-you', `type=${type}`);
    expect(reverse.body.items.every((i: any) => i.author.id !== viewer.user.id)).toBe(true);
  });

  it('sépare vidéos longues et Shorts', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const long = await publishedContent(creator.auth, 'VIDEO');
    const short = await publishedContent(creator.auth, 'SHORT');
    expect(ids(await feed(viewer.auth, 'for-you', 'type=video'))).toEqual([long.id]);
    expect(ids(await feed(viewer.auth, 'for-you', 'type=short'))).toEqual([short.id]);
    expect(ids(await feed(viewer.auth, 'trending'))).toEqual([long.id]); // type par défaut : video
  });

  it('« Abonnements » : uniquement les comptes suivis, du plus récent au plus ancien, paginé', async () => {
    const viewer = await signedIn(1);
    const followed = await creatorSignedIn(2);
    const stranger = await creatorSignedIn(3);
    const old = await publishedContent(followed.auth, kind, { title: 'ancien' });
    const mid = await publishedContent(followed.auth, kind, { title: 'milieu' });
    const recent = await publishedContent(followed.auth, kind, { title: 'récent' });
    await publishedContent(stranger.auth, kind);
    await publishedContent(followed.auth, kind, { visibility: 'UNLISTED' }); // jamais dans un feed
    await publishedAt(kind, old.id, hoursAgo(30));
    await publishedAt(kind, mid.id, hoursAgo(20));
    await publishedAt(kind, recent.id, hoursAgo(10));
    expect(ids(await feed(viewer.auth, 'following', `type=${type}`))).toEqual([]); // personne suivi
    await api().post(`/api/users/${followed.user.id}/follow`).set(viewer.auth).send({});
    const all = await feed(viewer.auth, 'following', `type=${type}`);
    expect(ids(all)).toEqual([recent.id, mid.id, old.id]);
    expect(all.body.items[0].viewer.followsAuthor).toBe(true);
    const p1 = await feed(viewer.auth, 'following', `type=${type}&limit=2`);
    expect(ids(p1)).toEqual([recent.id, mid.id]);
    const p2 = await feed(viewer.auth, 'following', `type=${type}&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(ids(p2)).toEqual([old.id]);
    expect(p2.body.nextCursor).toBeNull();
    // bloquer le compte suivi vide le feed
    await api().post(`/api/users/${followed.user.id}/block`).set(viewer.auth).send({});
    expect(ids(await feed(viewer.auth, 'following', `type=${type}`))).toEqual([]);
  });

  it('« Tendances » : le plus populaire d’abord, et la fraîcheur compte', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const quiet = await publishedContent(creator.auth, kind, { title: 'calme' });
    const hot = await publishedContent(creator.auth, kind, { title: 'populaire' });
    const stale = await publishedContent(creator.auth, kind, { title: 'ancien populaire' });
    const outside = await publishedContent(creator.auth, kind, { title: 'hors période' });
    await publishedAt(kind, quiet.id, hoursAgo(5));
    await publishedAt(kind, hot.id, hoursAgo(5));
    await publishedAt(kind, stale.id, hoursAgo(150));
    await publishedAt(kind, outside.id, hoursAgo(24 * 10));
    await setCounts(kind, hot.id, { viewCount: 500, likeCount: 80, commentCount: 20, shareCount: 10 });
    await setCounts(kind, stale.id, { viewCount: 500, likeCount: 80, commentCount: 20, shareCount: 10 });
    await setCounts(kind, outside.id, { viewCount: 9999, likeCount: 999 });
    const res = await feed(viewer.auth, 'trending', `type=${type}`);
    expect(ids(res)[0]).toBe(hot.id); // même popularité que « ancien populaire », mais bien plus récent
    expect(ids(res)).not.toContain(outside.id); // au-delà de 7 jours : exclu des tendances
    expect(ids(res).indexOf(hot.id)).toBeLessThan(ids(res).indexOf(quiet.id));
  });

  it('« Pour toi » : favorise les comptes suivis et relègue ce qui a déjà été vu', async () => {
    const viewer = await signedIn(1);
    const friend = await creatorSignedIn(2);
    const other = await creatorSignedIn(3);
    const fromFriend = await publishedContent(friend.auth, kind, { title: 'ami' });
    const fromOther = await publishedContent(other.auth, kind, { title: 'autre' });
    const t = hoursAgo(48); // même date : seules les préférences départagent
    await publishedAt(kind, fromFriend.id, t);
    await publishedAt(kind, fromOther.id, t);
    expect(ids(await feed(viewer.auth, 'for-you', `type=${type}`)).sort()).toEqual([fromFriend.id, fromOther.id].sort());
    await api().post(`/api/users/${friend.user.id}/follow`).set(viewer.auth).send({});
    expect(ids(await feed(viewer.auth, 'for-you', `type=${type}`))).toEqual([fromFriend.id, fromOther.id]);
    // l'ami est déjà vu : il passe derrière
    await api().post(`${basePath(kind)}/${fromFriend.id}/view`).set(viewer.auth).send({ watchedSeconds: 30 });
    expect(ids(await feed(viewer.auth, 'for-you', `type=${type}`))).toEqual([fromOther.id, fromFriend.id]);
  });

  it('« Pour toi » : pagination par curseur sans doublon', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await publishedContent(creator.auth, kind, { title: `n°${i}` })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = await feed(viewer.auth, 'for-you', `type=${type}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(made));
  });

  it('inclut les indicateurs du spectateur (like) dans chaque élément', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const c = await publishedContent(creator.auth, kind);
    await api().post(`${basePath(kind)}/${c.id}/like`).set(viewer.auth).send({});
    const res = await feed(viewer.auth, 'for-you', `type=${type}`);
    expect(res.body.items[0]).toMatchObject({ id: c.id, kind, viewer: { liked: true, followsAuthor: false, isOwner: false }, counts: { likes: 1 } });
    expect(res.body.items[0].author.id).toBe(creator.user.id);
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
    expect(K).toBeTruthy();
  });
});

describe('suppression de compte', () => {
  it('retire les contenus et les suivis du compte supprimé', async () => {
    const viewer = await signedIn(1);
    const creator = await creatorSignedIn(2);
    const c = await publishedContent(creator.auth, 'VIDEO');
    await api().post(`/api/users/${creator.user.id}/follow`).set(viewer.auth).send({});
    expect(ids(await feed(viewer.auth, 'for-you'))).toEqual([c.id]);
    const del = await api().delete('/api/users/me').set(creator.auth).send({ password: 'Passw0rdOK' });
    expect(del.status).toBe(204);
    expect(ids(await feed(viewer.auth, 'for-you'))).toEqual([]);
    expect(ids(await feed(viewer.auth, 'following'))).toEqual([]);
    expect((await api().get(`/api/videos/${c.id}`).set(viewer.auth)).status).toBe(404);
    expect(await prisma.follow.count()).toBe(0);
  });
});
