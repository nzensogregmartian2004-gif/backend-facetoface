import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, creatorSignedIn, publishedContent, resetDb, signedIn, createDraft, uploadedDraft, signUp, type Kind } from './helpers';

beforeEach(resetDb);

type Auth = { Authorization: string };
type S = { user: { id: string; username: string }; auth: Auth };
const follow = (a: S, b: S) => api().post(`/api/users/${b.user.id}/follow`).set(a.auth).send({});
const block = (a: S, b: S) => api().post(`/api/users/${b.user.id}/block`).set(a.auth).send({});
const get = (a: S, path: string) => api().get(path).set(a.auth);
const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);
const names = (res: { body: { items: { username: string }[] } }) => res.body.items.map((i) => i.username);
const suspend = (s: S) => prisma.user.update({ where: { id: s.user.id }, data: { status: 'SUSPENDED' } });
const setCounts = (kind: Kind, id: string, data: object) => (kind === 'VIDEO' ? prisma.video.update({ where: { id }, data }) : prisma.short.update({ where: { id }, data }));
const privacy = (s: S, profileVisibility: 'PUBLIC' | 'PRIVATE') => api().patch('/api/users/me/privacy').set(s.auth).send({ profileVisibility });

describe('profil public enrichi', () => {
  it('expose compteurs, statistiques publiques et relation avec le spectateur', async () => {
    const a = await signedIn(1);
    const c = await creatorSignedIn(2);
    const f = await signedIn(3);
    await follow(a, c); await follow(f, c); await follow(c, a);
    const v = await publishedContent(c.auth, 'VIDEO');
    const sh = await publishedContent(c.auth, 'SHORT');
    await setCounts('VIDEO', v.id, { viewCount: 10, likeCount: 3 });
    await setCounts('SHORT', sh.id, { viewCount: 5, likeCount: 2 });
    await createDraft(c.auth, 'VIDEO'); // un brouillon ne compte pas
    await publishedContent(c.auth, 'VIDEO', { visibility: 'PRIVATE' }); // ni un contenu privé
    const res = await get(a, `/api/users/${c.user.username}`);
    expect(res.status).toBe(200);
    expect(res.body.user.counts).toEqual({ followers: 2, following: 1, videos: 1, shorts: 1, views: 15, likes: 5 });
    expect(res.body.user.viewer).toMatchObject({ isSelf: false, isFollowing: true, followsMe: true });
    expect(res.body.user.creator.since).toBeTruthy();
    expect(res.body.user.email).toBeUndefined();
    expect(res.body.user.birthDate).toBeUndefined();
  });

  it('un compte non créateur n’a pas de bloc créateur ; l’alias « me » désigne le spectateur', async () => {
    const a = await signedIn(1);
    const res = await get(a, '/api/users/me');
    expect(res.status).toBe(200); // /me reste le profil complet
    const p = await get(a, `/api/users/${a.user.username}`);
    expect(p.body.user.creator).toBeNull();
    expect(p.body.user.viewer.isSelf).toBe(true);
    const me = await get(a, '/api/users/me/followers');
    expect(me.status).toBe(200);
  });

  it('ne compte pas les abonnés dont le compte n’est plus actif', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    await follow(b, a); await follow(c, a);
    await suspend(c);
    expect((await get(b, `/api/users/${a.user.username}`)).body.user.counts.followers).toBe(1);
  });

  it('404 si l’utilisateur est inconnu, suspendu, ou vous a bloqué', async () => {
    const a = await signedIn(1); const b = await signedIn(2); const c = await signedIn(3);
    expect((await get(a, '/api/users/inconnu_x')).status).toBe(404);
    await block(b, a);
    expect((await get(a, `/api/users/${b.user.username}`)).status).toBe(404);
    expect((await get(a, `/api/users/${b.user.username}/followers`)).status).toBe(404);
    expect((await get(a, `/api/users/${b.user.username}/videos`)).status).toBe(404);
    await suspend(c);
    expect((await get(a, `/api/users/${c.user.username}`)).status).toBe(404);
  });

  it('si je l’ai bloqué : profil visible avec le drapeau, mais listes et contenus vides', async () => {
    const a = await signedIn(1); const c = await creatorSignedIn(2); const f = await signedIn(3);
    await publishedContent(c.auth, 'VIDEO'); await follow(f, c);
    await block(a, c);
    const p = await get(a, `/api/users/${c.user.username}`);
    expect(p.status).toBe(200);
    expect(p.body.user.isBlockedByMe).toBe(true);
    expect((await get(a, `/api/users/${c.user.username}/videos`)).body.items).toEqual([]);
    expect((await get(a, `/api/users/${c.user.username}/followers`)).body.items).toEqual([]);
  });

  it('profil privé : bio, compteurs d’abonnés et listes masqués aux autres, contenu public conservé', async () => {
    const o = await creatorSignedIn(1); const v = await signedIn(2);
    await api().patch('/api/users/me').set(o.auth).send({ bio: 'secret' });
    await publishedContent(o.auth, 'VIDEO');
    await follow(v, o);
    await privacy(o, 'PRIVATE');
    const seen = (await get(v, `/api/users/${o.user.username}`)).body.user;
    expect(seen.bio).toBeNull();
    expect(seen.isPrivate).toBe(true);
    expect(seen.counts.followers).toBeNull();
    expect(seen.counts.following).toBeNull();
    expect(seen.counts.videos).toBe(1);
    const f = await get(v, `/api/users/${o.user.username}/followers`);
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe('PROFILE_PRIVATE');
    expect((await get(v, `/api/users/${o.user.username}/following`)).status).toBe(403);
    expect((await get(v, `/api/users/${o.user.username}/videos`)).body.items).toHaveLength(1);
    // le propriétaire voit tout
    const mine = (await get(o, `/api/users/${o.user.username}`)).body.user;
    expect(mine.counts.followers).toBe(1);
    expect((await get(o, '/api/users/me/followers')).status).toBe(200);
  });
});

describe('abonnés et abonnements', () => {
  it('liste du plus récent au plus ancien, paginée, avec la relation du spectateur', async () => {
    const t = await signedIn(1);
    const u = [await signedIn(2), await signedIn(3), await signedIn(4)];
    for (const x of u) await follow(x, t);
    await follow(t, u[0]); // u[0] est aussi suivi par t
    const viewer = await signedIn(5);
    await follow(viewer, u[1]);
    const p1 = await get(viewer, `/api/users/${t.user.username}/followers?limit=2`);
    expect(names(p1)).toEqual([u[2].user.username, u[1].user.username]);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await get(viewer, `/api/users/${t.user.username}/followers?limit=2&cursor=${p1.body.nextCursor}`);
    expect(names(p2)).toEqual([u[0].user.username]);
    expect(p2.body.nextCursor).toBeNull();
    const byName = Object.fromEntries([...p1.body.items, ...p2.body.items].map((i: any) => [i.username, i]));
    expect(byName[u[1].user.username].viewer.isFollowing).toBe(true);
    expect(byName[u[2].user.username].viewer.isFollowing).toBe(false);
    expect(byName[u[0].user.username].email).toBeUndefined();
    expect(byName[u[0].user.username].followersCount).toBe(1);
    const fw = await get(viewer, `/api/users/${t.user.username}/following`);
    expect(names(fw)).toEqual([u[0].user.username]);
  });

  it('exclut les comptes inactifs et ceux avec lesquels le spectateur a un blocage', async () => {
    const t = await signedIn(1); const a = await signedIn(2); const b = await signedIn(3); const c = await signedIn(4);
    const viewer = await signedIn(5);
    for (const x of [a, b, c]) await follow(x, t);
    await suspend(a);
    await block(viewer, b);
    const res = await get(viewer, `/api/users/${t.user.username}/followers`);
    expect(names(res)).toEqual([c.user.username]);
  });

  it('indique le spectateur lui-même dans la liste (isSelf)', async () => {
    const t = await signedIn(1); const v = await signedIn(2);
    await follow(v, t);
    const res = await get(v, `/api/users/${t.user.username}/followers`);
    expect(res.body.items[0].viewer.isSelf).toBe(true);
  });

  it('rejette un curseur ou une limite invalides', async () => {
    const t = await signedIn(1);
    expect((await get(t, `/api/users/${t.user.username}/followers?cursor=zzz`)).status).toBe(400);
    expect((await get(t, `/api/users/${t.user.username}/followers?limit=500`)).status).toBe(400);
  });

  it('bloquer rompt les suivis et les retire des listes', async () => {
    const a = await signedIn(1); const b = await signedIn(2);
    await follow(a, b); await follow(b, a);
    await block(a, b);
    expect((await get(a, '/api/users/me/followers')).body.items).toEqual([]);
    expect((await get(a, '/api/users/me/following')).body.items).toEqual([]);
  });
});

describe.each<Kind>(['VIDEO', 'SHORT'])('contenus d’un profil — %s', (kind) => {
  const route = kind === 'VIDEO' ? 'videos' : 'shorts';
  it('ne montre que le contenu publié et public, du plus récent au plus ancien, paginé', async () => {
    const c = await creatorSignedIn(1); const v = await signedIn(2);
    const first = await publishedContent(c.auth, kind, { title: 'A' });
    await setCounts(kind, first.id, { publishedAt: new Date(Date.now() - 60_000) });
    const second = await publishedContent(c.auth, kind, { title: 'B' });
    await createDraft(c.auth, kind);
    await uploadedDraft(c.auth, kind);
    await publishedContent(c.auth, kind, { visibility: 'PRIVATE' });
    await publishedContent(c.auth, kind, { visibility: 'UNLISTED' });
    const hidden = await publishedContent(c.auth, kind);
    await api().patch(`/api/${route}/${hidden.id}`).set(c.auth).send({ visibility: 'PRIVATE' });
    const p1 = await get(v, `/api/users/${c.user.username}/${route}?limit=1`);
    expect(ids(p1)).toEqual([second.id]);
    const p2 = await get(v, `/api/users/${c.user.username}/${route}?limit=1&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([first.id]);
    expect(p2.body.nextCursor).toBeNull();
    expect(p1.body.items[0].viewer.followsAuthor).toBe(false);
  });

  it('tri « popular » par vues, sort invalide refusé, utilisateur inconnu 404', async () => {
    const c = await creatorSignedIn(1); const v = await signedIn(2);
    const a = await publishedContent(c.auth, kind); const b = await publishedContent(c.auth, kind);
    await setCounts(kind, a.id, { viewCount: 5 }); await setCounts(kind, b.id, { viewCount: 50 });
    expect(ids(await get(v, `/api/users/${c.user.username}/${route}?sort=popular`))).toEqual([b.id, a.id]);
    const p1 = await get(v, `/api/users/${c.user.username}/${route}?sort=popular&limit=1`);
    const p2 = await get(v, `/api/users/${c.user.username}/${route}?sort=popular&limit=1&cursor=${p1.body.nextCursor}`);
    expect([...ids(p1), ...ids(p2)]).toEqual([b.id, a.id]);
    expect((await get(v, `/api/users/${c.user.username}/${route}?sort=bof`)).status).toBe(400);
    expect((await get(v, `/api/users/nobody_x/${route}`)).status).toBe(404);
  });

  it('« me » liste mes contenus publics', async () => {
    const c = await creatorSignedIn(1);
    const a = await publishedContent(c.auth, kind);
    await createDraft(c.auth, kind);
    expect(ids(await get(c, `/api/users/me/${route}`))).toEqual([a.id]);
  });
});

describe('recherche', () => {
  it('exige une session et refuse une requête trop courte', async () => {
    expect((await api().get('/api/search?q=ab')).status).toBe(401);
    const a = await signedIn(1);
    const r = await get(a, '/api/search?q=a');
    expect(r.status).toBe(400);
    expect(r.body.error.details.q).toBeTruthy();
    expect((await get(a, '/api/search?type=videos')).status).toBe(400); // ni mot-clé ni catégorie
    expect((await get(a, '/api/search?q=ab&sort=views')).status).toBe(400); // vues : contenus seulement
    expect((await get(a, '/api/search?q=ab&category=music')).status).toBe(400);
    expect((await get(a, '/api/search?q=ab&type=lives')).status).toBe(400);
  });

  it('trouve les créateurs par identifiant ou nom (insensible à la casse, « @ » toléré), jamais soi-même', async () => {
    const me = await creatorSignedIn(1);
    const c = await creatorSignedIn(2);
    const n = await signedIn(3); // non créateur
    await api().patch('/api/users/me').set(c.auth).send({ displayName: 'Marie Danse' });
    expect(names(await get(me, '/api/search?q=MARIE'))).toEqual([c.user.username]);
    expect(names(await get(me, '/api/search?q=@user_2'))).toEqual([c.user.username]);
    expect(names(await get(me, '/api/search?q=user_&type=creators'))).toEqual([c.user.username]); // ni soi-même, ni un non-créateur
    expect(names(await get(me, '/api/search?q=user_&type=users')).sort()).toEqual([c.user.username, n.user.username].sort());
    const item = (await get(me, '/api/search?q=user_2')).body.items[0];
    expect(item.email).toBeUndefined();
    expect(item.viewer.isFollowing).toBe(false);
  });

  it('« _ » et « % » sont littéraux', async () => {
    const me = await signedIn(1);
    await signedIn(2);
    await api().patch('/api/users/me').set((await signedIn(3)).auth).send({ username: 'userx3' });
    expect(names(await get(me, '/api/search?q=user_2&type=users'))).toEqual(['user_2']);
    expect((await get(me, '/api/search?q=%25%25&type=users')).body.items).toEqual([]);
  });

  it('classe par popularité (abonnés) ou par ancienneté du compte, paginé', async () => {
    const me = await signedIn(1);
    const a = await creatorSignedIn(2); const b = await creatorSignedIn(3); const c = await creatorSignedIn(4);
    await follow(me, b); await follow((await signedIn(5)), b); await follow(me, c);
    expect(names(await get(me, '/api/search?q=user_&type=creators'))).toEqual([b.user.username, c.user.username, a.user.username]);
    expect(names(await get(me, '/api/search?q=user_&type=creators&sort=recent'))).toEqual([c.user.username, b.user.username, a.user.username]);
    const p1 = await get(me, '/api/search?q=user_&type=creators&limit=2');
    const p2 = await get(me, `/api/search?q=user_&type=creators&limit=2&cursor=${p1.body.nextCursor}`);
    expect([...names(p1), ...names(p2)]).toEqual([b.user.username, c.user.username, a.user.username]);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('exclut comptes inactifs et blocages dans les deux sens', async () => {
    const me = await signedIn(1);
    const a = await creatorSignedIn(2); const b = await creatorSignedIn(3); const c = await creatorSignedIn(4); const d = await creatorSignedIn(5);
    await suspend(a); await block(me, b); await block(c, me);
    expect(names(await get(me, '/api/search?q=user_&type=creators'))).toEqual([d.user.username]);
  });

  it('cherche dans les vidéos (titre, description, auteur) sans montrer brouillons, privés ni non répertoriés', async () => {
    const c = await creatorSignedIn(1); const v = await signedIn(2);
    const t = await publishedContent(c.auth, 'VIDEO', { title: 'Cours de salsa' });
    const d = await publishedContent(c.auth, 'VIDEO', { title: 'Autre', description: 'on danse la SALSA ici' });
    await publishedContent(c.auth, 'VIDEO', { title: 'Autre chose' });
    await publishedContent(c.auth, 'VIDEO', { title: 'salsa privée', visibility: 'PRIVATE' });
    await publishedContent(c.auth, 'VIDEO', { title: 'salsa lien', visibility: 'UNLISTED' });
    await createDraft(c.auth, 'VIDEO', { title: 'salsa brouillon' });
    expect(new Set(ids(await get(v, '/api/search?q=salsa&type=videos')))).toEqual(new Set([t.id, d.id]));
    expect(ids(await get(v, '/api/search?q=user_1&type=videos'))).toHaveLength(3); // par auteur
    expect(ids(await get(v, '/api/search?q=salsa&type=shorts'))).toEqual([]); // les types ne se mélangent pas
  });

  it('filtre par catégorie (sans mot-clé) et trie par vues, popularité ou date', async () => {
    const c = await creatorSignedIn(1); const v = await signedIn(2);
    const m1 = await publishedContent(c.auth, 'SHORT', { category: 'music', title: 'm1' });
    const m2 = await publishedContent(c.auth, 'SHORT', { category: 'music', title: 'm2' });
    const s1 = await publishedContent(c.auth, 'SHORT', { category: 'sport', title: 's1' });
    await setCounts('SHORT', m1.id, { viewCount: 100, likeCount: 1 });
    await setCounts('SHORT', m2.id, { viewCount: 10, likeCount: 9 });
    await setCounts('SHORT', s1.id, { viewCount: 1000, likeCount: 50 });
    await prisma.short.update({ where: { id: m1.id }, data: { publishedAt: new Date(Date.now() - 3_600_000) } });
    expect(new Set(ids(await get(v, '/api/search?type=shorts&category=music')))).toEqual(new Set([m1.id, m2.id]));
    expect(ids(await get(v, '/api/search?type=shorts&category=music&sort=views'))).toEqual([m1.id, m2.id]);
    expect(ids(await get(v, '/api/search?type=shorts&category=music&sort=popular'))).toEqual([m2.id, m1.id]);
    expect(ids(await get(v, '/api/search?type=shorts&category=music&sort=recent'))).toEqual([m2.id, m1.id]);
    expect((await get(v, '/api/search?type=shorts&category=inconnue')).status).toBe(400);
    const p1 = await get(v, '/api/search?type=shorts&category=music&sort=views&limit=1');
    const p2 = await get(v, `/api/search?type=shorts&category=music&sort=views&limit=1&cursor=${p1.body.nextCursor}`);
    expect([...ids(p1), ...ids(p2)]).toEqual([m1.id, m2.id]);
  });

  it('exclut le contenu des auteurs bloqués ou inactifs', async () => {
    const c1 = await creatorSignedIn(1); const c2 = await creatorSignedIn(2); const c3 = await creatorSignedIn(3); const v = await signedIn(4);
    await publishedContent(c1.auth, 'VIDEO', { title: 'rumba 1' });
    await publishedContent(c2.auth, 'VIDEO', { title: 'rumba 2' });
    const ok = await publishedContent(c3.auth, 'VIDEO', { title: 'rumba 3' });
    await block(v, c1); await block(c2, v);
    expect(ids(await get(v, '/api/search?q=rumba&type=videos'))).toEqual([ok.id]);
    await suspend(c3);
    expect(ids(await get(v, '/api/search?q=rumba&type=videos'))).toEqual([]);
  });

  it('liste les catégories filtrables', async () => {
    const a = await signedIn(1);
    const r = await get(a, '/api/search/categories');
    expect(r.status).toBe(200);
    expect(r.body.categories.map((c: { slug: string }) => c.slug)).toContain('music');
  });
});

describe('suggestions de créateurs', () => {
  it('ne propose ni soi-même, ni suivis, ni bloqués, ni non-créateurs, ni créateurs sans contenu public', async () => {
    const me = await creatorSignedIn(1);
    await publishedContent(me.auth, 'VIDEO');
    const ok = await creatorSignedIn(2); await publishedContent(ok.auth, 'VIDEO');
    const followed = await creatorSignedIn(3); await publishedContent(followed.auth, 'VIDEO');
    const blocked = await creatorSignedIn(4); await publishedContent(blocked.auth, 'VIDEO');
    const blocker = await creatorSignedIn(5); await publishedContent(blocker.auth, 'VIDEO');
    await creatorSignedIn(6); // aucun contenu
    const priv = await creatorSignedIn(7); await publishedContent(priv.auth, 'VIDEO', { visibility: 'PRIVATE' });
    await signedIn(8); // non créateur
    await follow(me, followed); await block(me, blocked); await block(blocker, me);
    const r = await get(me, '/api/users/suggestions');
    expect(r.status).toBe(200);
    expect(names(r)).toEqual([ok.user.username]);
    expect(r.body.items[0].reason).toBe('POPULAR');
    expect(r.body.items[0].email).toBeUndefined();
  });

  it('place en tête les créateurs suivis par mes abonnements, même peu populaires', async () => {
    const me = await signedIn(1);
    const friend = await signedIn(2);
    const pop = await creatorSignedIn(3); await publishedContent(pop.auth, 'VIDEO');
    const niche = await creatorSignedIn(4); await publishedContent(niche.auth, 'SHORT');
    for (let i = 10; i < 13; i++) await follow(await signedIn(i), pop);
    await follow(me, friend); await follow(friend, niche);
    const r = await get(me, '/api/users/suggestions');
    expect(names(r)).toEqual([niche.user.username, pop.user.username]);
    expect(r.body.items[0]).toMatchObject({ reason: 'MUTUAL', mutualCount: 1 });
    expect(r.body.items[1].reason).toBe('POPULAR');
  });

  it('tient compte des catégories de mes derniers likes, et respecte la limite', async () => {
    const me = await signedIn(1);
    const jazz = await creatorSignedIn(2); const sport = await creatorSignedIn(3);
    const likedItem = await publishedContent(jazz.auth, 'VIDEO', { category: 'music' });
    await publishedContent(sport.auth, 'VIDEO', { category: 'sport' });
    const other = await creatorSignedIn(4); await publishedContent(other.auth, 'VIDEO', { category: 'music' });
    await api().post(`/api/videos/${likedItem.id}/like`).set(me.auth).send({});
    await follow(me, jazz); // jazz est suivi : il disparaît, mais « other » partage la catégorie musique
    const r = await get(me, '/api/users/suggestions');
    expect(names(r)[0]).toBe(other.user.username);
    expect(r.body.items[0].reason).toBe('INTERESTS');
    expect((await get(me, '/api/users/suggestions?limit=1')).body.items).toHaveLength(1);
    expect((await get(me, '/api/users/suggestions?limit=99')).status).toBe(400);
  });

  it('l’identifiant « suggestions » est réservé (la route ne peut pas être masquée par un profil)', async () => {
    const r = await signUp(9, { username: 'suggestions' });
    expect(r.status).toBe(400);
    expect(r.body.error.details.username).toBeTruthy();
  });
});
