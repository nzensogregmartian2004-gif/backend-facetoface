import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, basePath, bodyKey, createDraft, creatorSignedIn, publishedContent, resetDb, signedIn, type Kind } from './helpers';

beforeEach(resetDb);

describe.each<Kind>(['VIDEO', 'SHORT'])('interactions %s', (kind) => {
  const P = basePath(kind);
  const K = bodyKey(kind);

  it('likes : idempotents, compteur exact, retirables', async () => {
    const owner = await creatorSignedIn(1);
    const fan = await signedIn(2);
    const fan2 = await signedIn(3);
    const c = await publishedContent(owner.auth, kind);
    const like = (a: { Authorization: string }) => api().post(`${P}/${c.id}/like`).set(a).send({});
    expect((await like(fan.auth)).body).toEqual({ liked: true, likeCount: 1 });
    expect((await like(fan.auth)).body).toEqual({ liked: true, likeCount: 1 }); // pas de double compte
    expect((await like(fan2.auth)).body.likeCount).toBe(2);
    expect((await api().get(`${P}/${c.id}`).set(fan.auth)).body[K]).toMatchObject({ viewer: { liked: true }, counts: { likes: 2 } });
    expect((await api().delete(`${P}/${c.id}/like`).set(fan.auth)).body).toEqual({ liked: false, likeCount: 1 });
    expect((await api().delete(`${P}/${c.id}/like`).set(fan.auth)).body).toEqual({ liked: false, likeCount: 1 }); // pas de compteur négatif
    expect((await api().get(`${P}/${c.id}`).set(fan.auth)).body[K].viewer.liked).toBe(false);
    expect(await prisma.like.count({ where: { targetId: c.id } })).toBe(1);
  });

  it('likes : impossibles sur un brouillon, un contenu privé ou inexistant', async () => {
    const owner = await creatorSignedIn(1);
    const fan = await signedIn(2);
    const draft = await createDraft(owner.auth, kind);
    const priv = await publishedContent(owner.auth, kind, { visibility: 'PRIVATE' });
    for (const id of [draft.id, priv.id, 'inconnu']) {
      expect((await api().post(`${P}/${id}/like`).set(fan.auth).send({})).status).toBe(404);
    }
    expect((await api().post(`${P}/${draft.id}/like`).set(owner.auth).send({})).status).toBe(404); // même l'auteur : pas de like sur brouillon
  });

  it('vues : une par utilisateur et par fenêtre, jamais pour l’auteur', async () => {
    const owner = await creatorSignedIn(1);
    const fan = await signedIn(2);
    const fan2 = await signedIn(3);
    const c = await publishedContent(owner.auth, kind);
    const view = (a: { Authorization: string }, b: object = {}) => api().post(`${P}/${c.id}/view`).set(a).send(b);
    expect((await view(owner.auth)).body).toEqual({ counted: false, viewCount: 0 });
    expect((await view(fan.auth, { watchedSeconds: 5 })).body).toEqual({ counted: true, viewCount: 1 });
    expect((await view(fan.auth, { watchedSeconds: 12 })).body).toEqual({ counted: false, viewCount: 1 }); // dédoublonné
    expect((await view(fan2.auth)).body).toEqual({ counted: true, viewCount: 2 });
    const rows = await prisma.contentView.findMany({ where: { userId: fan.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].watchedSeconds).toBe(12); // la durée regardée est mise à jour sans recompter
    // hors de la fenêtre de dédoublonnage, la vue compte à nouveau
    await prisma.contentView.updateMany({ where: { userId: fan.user.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await view(fan.auth)).body).toEqual({ counted: true, viewCount: 3 });
    expect((await view(fan.auth, { watchedSeconds: -1 })).status).toBe(400);
  });

  it('partage : compteur et lien ; refusé sur un contenu privé', async () => {
    const owner = await creatorSignedIn(1);
    const fan = await signedIn(2);
    const c = await publishedContent(owner.auth, kind);
    const res = await api().post(`${P}/${c.id}/share`).set(fan.auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.shareCount).toBe(1);
    expect(res.body.shareUrl).toBe(`http://localhost:4000/${kind === 'SHORT' ? 'shorts' : 'videos'}/${c.id}`);
    expect((await api().post(`${P}/${c.id}/share`).set(fan.auth).send({})).body.shareCount).toBe(2);
    const priv = await publishedContent(owner.auth, kind, { visibility: 'PRIVATE' });
    expect((await api().post(`${P}/${priv.id}/share`).set(owner.auth).send({})).body.error.code).toBe('SHARE_NOT_ALLOWED');
  });

  describe('commentaires', () => {
    it('crée, liste (récent d’abord, paginé) et tient le compteur à jour', async () => {
      const owner = await creatorSignedIn(1);
      const fan = await signedIn(2);
      const c = await publishedContent(owner.auth, kind);
      for (const t of ['premier', 'deuxième', 'troisième']) {
        const r = await api().post(`${P}/${c.id}/comments`).set(fan.auth).send({ text: `  ${t}  ` });
        expect(r.status).toBe(201);
        expect(r.body.comment).toMatchObject({ text: t, canDelete: true });
        expect(r.body.comment.author.id).toBe(fan.user.id);
        expect(JSON.stringify(r.body)).not.toContain('@example.com');
        await prisma.comment.updateMany({ where: { text: t }, data: { createdAt: new Date(Date.now() + ['premier', 'deuxième', 'troisième'].indexOf(t) * 1000) } });
      }
      const p1 = await api().get(`${P}/${c.id}/comments?limit=2`).set(owner.auth);
      expect(p1.body.items.map((x: any) => x.text)).toEqual(['troisième', 'deuxième']);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await api().get(`${P}/${c.id}/comments?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set(owner.auth);
      expect(p2.body.items.map((x: any) => x.text)).toEqual(['premier']);
      expect(p2.body.nextCursor).toBeNull();
      expect((await api().get(`${P}/${c.id}`).set(fan.auth)).body[K].counts.comments).toBe(3);
    });

    it('valide le texte', async () => {
      const owner = await creatorSignedIn(1);
      const c = await publishedContent(owner.auth, kind);
      for (const text of ['', '   ', 'x'.repeat(501)]) {
        expect((await api().post(`${P}/${c.id}/comments`).set(owner.auth).send({ text })).status).toBe(400);
      }
      expect((await api().post(`${P}/${c.id}/comments`).set(owner.auth).send({})).status).toBe(400);
    });

    it('suppression : l’auteur du commentaire ou le propriétaire du contenu, jamais un tiers', async () => {
      const owner = await creatorSignedIn(1);
      const a = await signedIn(2);
      const b = await signedIn(3);
      const c = await publishedContent(owner.auth, kind);
      const mk = async (who: typeof a) => (await api().post(`${P}/${c.id}/comments`).set(who.auth).send({ text: 'hello' })).body.comment.id as string;
      const c1 = await mk(a);
      const c2 = await mk(a);
      expect((await api().delete(`/api/comments/${c1}`).set(b.auth)).status).toBe(404); // tiers
      expect((await api().delete(`/api/comments/${c1}`).set(a.auth)).status).toBe(204); // auteur
      expect((await api().delete(`/api/comments/${c2}`).set(owner.auth)).status).toBe(204); // propriétaire du contenu
      expect((await api().delete(`/api/comments/${c1}`).set(a.auth)).status).toBe(404); // déjà supprimé
      expect((await api().get(`${P}/${c.id}`).set(a.auth)).body[K].counts.comments).toBe(0);
      expect((await api().get(`${P}/${c.id}/comments`).set(a.auth)).body.items).toHaveLength(0);
      expect(await prisma.comment.count({ where: { targetId: c.id } })).toBe(2); // suppression douce : conservés pour la modération
    });

    it('commentaires désactivés : création refusée, liste vide', async () => {
      const owner = await creatorSignedIn(1);
      const fan = await signedIn(2);
      const c = await publishedContent(owner.auth, kind, { allowComments: false });
      const res = await api().post(`${P}/${c.id}/comments`).set(fan.auth).send({ text: 'salut' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('COMMENTS_DISABLED');
      expect((await api().get(`${P}/${c.id}/comments`).set(fan.auth)).body).toEqual({ items: [], nextCursor: null, allowComments: false });
    });

    it('blocage : commentaires masqués dans les deux sens, et pas de commentaire chez qui vous a bloqué', async () => {
      const owner = await creatorSignedIn(1);
      const a = await signedIn(2);
      const b = await signedIn(3);
      const c = await publishedContent(owner.auth, kind);
      await api().post(`${P}/${c.id}/comments`).set(a.auth).send({ text: 'de A' });
      await api().post(`${P}/${c.id}/comments`).set(b.auth).send({ text: 'de B' });
      expect((await api().get(`${P}/${c.id}/comments`).set(b.auth)).body.items).toHaveLength(2);
      await api().post(`/api/users/${a.user.id}/block`).set(b.auth).send({}); // B bloque A
      expect((await api().get(`${P}/${c.id}/comments`).set(b.auth)).body.items.map((x: any) => x.text)).toEqual(['de B']);
      expect((await api().get(`${P}/${c.id}/comments`).set(a.auth)).body.items.map((x: any) => x.text)).toEqual(['de A']); // A ne voit plus B non plus
      expect((await api().get(`${P}/${c.id}/comments`).set(owner.auth)).body.items).toHaveLength(2); // le propriétaire voit tout
      await api().post(`/api/users/${a.user.id}/block`).set(owner.auth).send({}); // le propriétaire bloque A
      expect((await api().post(`${P}/${c.id}/comments`).set(a.auth).send({ text: 'encore' })).status).toBe(404);
      expect((await api().get(`${P}/${c.id}/comments`).set(a.auth)).status).toBe(404);
    });
  });
});

describe('signalements de contenu', () => {
  const report = (a: { Authorization: string }, b: object) => api().post('/api/moderation/reports').set(a).send(b);

  it.each<Kind>(['VIDEO', 'SHORT'])('signale un %s visible, sans doublon, et refuse le reste', async (kind) => {
    const owner = await creatorSignedIn(1);
    const fan = await signedIn(2);
    const c = await publishedContent(owner.auth, kind);
    const r1 = await report(fan.auth, { targetType: kind, targetId: c.id, reason: 'SPAM', details: 'pub' });
    expect(r1.status).toBe(201);
    const r2 = await report(fan.auth, { targetType: kind, targetId: c.id, reason: 'SPAM' });
    expect(r2.status).toBe(200);
    expect(r2.body.report.id).toBe(r1.body.report.id);
    expect(await prisma.report.count({ where: { targetId: c.id } })).toBe(1);
    expect((await report(owner.auth, { targetType: kind, targetId: c.id, reason: 'SPAM' })).body.error.code).toBe('CANNOT_TARGET_SELF');
    expect((await report(fan.auth, { targetType: kind, targetId: 'inconnu', reason: 'SPAM' })).status).toBe(404);
    const priv = await publishedContent(owner.auth, kind, { visibility: 'PRIVATE' });
    expect((await report(fan.auth, { targetType: kind, targetId: priv.id, reason: 'SPAM' })).status).toBe(404); // pas de fuite d'existence
    // une vidéo ne se signale pas comme un Short, et inversement
    expect((await report(fan.auth, { targetType: kind === 'VIDEO' ? 'SHORT' : 'VIDEO', targetId: c.id, reason: 'SPAM' })).status).toBe(404);
  });

  it('signale un commentaire', async () => {
    const owner = await creatorSignedIn(1);
    const a = await signedIn(2);
    const b = await signedIn(3);
    const c = await publishedContent(owner.auth);
    const com = (await api().post(`/api/videos/${c.id}/comments`).set(a.auth).send({ text: 'méchant' })).body.comment.id as string;
    const ok = await report(b.auth, { targetType: 'COMMENT', targetId: com, reason: 'HARASSMENT' });
    expect(ok.status).toBe(201);
    expect((await report(a.auth, { targetType: 'COMMENT', targetId: com, reason: 'HARASSMENT' })).body.error.code).toBe('CANNOT_TARGET_SELF');
    expect((await report(b.auth, { targetType: 'COMMENT', targetId: 'inconnu', reason: 'SPAM' })).status).toBe(404);
    await api().delete(`/api/comments/${com}`).set(a.auth);
    expect((await report(b.auth, { targetType: 'COMMENT', targetId: com, reason: 'SPAM' })).status).toBe(404); // supprimé
  });

  it('LIVE, MESSAGE et PAID_CONTENT sont signalables : une cible inconnue donne 404', async () => {
    const fan = await signedIn(1);
    for (const targetType of ['LIVE', 'MESSAGE', 'PAID_CONTENT']) {
      const res = await report(fan.auth, { targetType, targetId: 'x', reason: 'SPAM' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});
