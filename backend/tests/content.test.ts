import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, basePath, bodyKey, createDraft, creatorSignedIn, memStore, publishedContent, resetDb, signedIn, uploadedDraft, type Kind } from './helpers';

beforeEach(resetDb);

describe.each<Kind>(['VIDEO', 'SHORT'])('contenu %s : brouillon et métadonnées', (kind) => {
  const P = basePath(kind);
  const K = bodyKey(kind);

  it('exige les fonctions créateur pour publier', async () => {
    const { auth } = await signedIn(1);
    const res = await api().post(P).set(auth).send({ title: 'Salut', category: 'music' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CREATOR_REQUIRED');
  });

  it('crée un brouillon avec des valeurs par défaut sûres', async () => {
    const { auth, user } = await creatorSignedIn(1);
    const res = await api().post(P).set(auth).send({ title: '  Mon titre  ', category: 'music', description: '' });
    expect(res.status).toBe(201);
    expect(res.body[K]).toMatchObject({ kind, title: 'Mon titre', description: null, category: 'music', visibility: 'PUBLIC', status: 'DRAFT', allowDownload: false, allowComments: true, uploaded: false, thumbnailUrl: null });
    expect(res.body[K].author.id).toBe(user.id);
    expect(res.body[K].counts).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
    expect(JSON.stringify(res.body)).not.toContain('@example.com'); // aucun e-mail dans l'auteur
  });

  it('valide les champs (titre, catégorie, champs inconnus)', async () => {
    const { auth } = await creatorSignedIn(1);
    for (const bad of [{ category: 'music' }, { title: '   ', category: 'music' }, { title: 'x'.repeat(101), category: 'music' }, { title: 'ok', category: 'inconnue' }, { title: 'ok', category: 'music', status: 'PUBLISHED' }, { title: 'ok', category: 'music', authorId: 'x' }, { title: 'ok', category: 'music', description: 'x'.repeat(2001) }]) {
      const res = await api().post(P).set(auth).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('exige une authentification', async () => {
    expect((await api().post(P).send({ title: 'a', category: 'music' })).status).toBe(401);
    expect((await api().get(`${P}/abc`)).status).toBe(401);
  });

  it('liste les catégories', async () => {
    const { auth } = await signedIn(1);
    const res = await api().get(`${P}/categories`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThan(5);
    expect(res.body.categories[0]).toEqual({ slug: 'music', name: 'Musique' });
  });

  it('modifie ses métadonnées, pas celles des autres', async () => {
    const a = await creatorSignedIn(1);
    const b = await creatorSignedIn(2);
    const d = await createDraft(a.auth, kind);
    const ok = await api().patch(`${P}/${d.id}`).set(a.auth).send({ title: 'Nouveau', visibility: 'UNLISTED', allowDownload: true, allowComments: false, description: 'texte' });
    expect(ok.status).toBe(200);
    expect(ok.body[K]).toMatchObject({ title: 'Nouveau', visibility: 'UNLISTED', allowDownload: true, allowComments: false, description: 'texte' });
    expect((await api().patch(`${P}/${d.id}`).set(b.auth).send({ title: 'Piraté' })).status).toBe(404);
    expect((await api().patch(`${P}/${d.id}`).set(a.auth).send({})).status).toBe(400);
    expect((await api().patch(`${P}/${d.id}`).set(a.auth).send({ status: 'PUBLISHED' })).status).toBe(400);
  });

  it('liste « mes contenus » avec pagination et filtre de statut', async () => {
    const { auth } = await creatorSignedIn(1);
    await createDraft(auth, kind, { title: 'brouillon' });
    await publishedContent(auth, kind, { title: 'A' });
    await publishedContent(auth, kind, { title: 'B' });
    const all = await api().get(`${P}/mine?limit=2`).set(auth);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await api().get(`${P}/mine?limit=2&cursor=${encodeURIComponent(all.body.nextCursor)}`).set(auth);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();
    const pub = await api().get(`${P}/mine?status=PUBLISHED`).set(auth);
    expect(pub.body.items).toHaveLength(2);
    expect((await api().get(`${P}/mine?cursor=pas-un-curseur`).set(auth)).status).toBe(400);
  });
});

describe.each<Kind>(['VIDEO', 'SHORT'])('contenu %s : envoi direct au stockage objet', (kind) => {
  const P = basePath(kind);
  const K = bodyKey(kind);

  it('délivre une URL pré-signée avec une clé choisie par le serveur', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    const res = await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/mp4' } });
    expect(res.body.upload.key).toMatch(new RegExp(`^${kind === 'SHORT' ? 'shorts' : 'videos'}/${d.id}/source-[\\w-]+\\.mp4$`));
    expect(res.body.upload.url).toContain(res.body.upload.key);
    expect(Date.parse(res.body.upload.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('refuse les formats non pris en charge et les fichiers trop gros', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    const send = (b: object) => api().post(`${P}/${d.id}/upload-url`).set(auth).send(b);
    expect((await send({ file: 'video', contentType: 'application/pdf', sizeBytes: 10 })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await send({ file: 'video', contentType: 'image/png', sizeBytes: 10 })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await send({ file: 'thumbnail', contentType: 'video/mp4', sizeBytes: 10 })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await send({ file: 'video', contentType: 'video/mp4', sizeBytes: 2_000_000_000 })).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await send({ file: 'thumbnail', contentType: 'image/png', sizeBytes: 50_000_000 })).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await send({ file: 'video', contentType: 'video/mp4', sizeBytes: 0 })).status).toBe(400);
    expect((await send({ file: 'audio', contentType: 'video/mp4', sizeBytes: 5 })).status).toBe(400);
  });

  it('ne laisse envoyer que sur son propre contenu', async () => {
    const a = await creatorSignedIn(1);
    const b = await creatorSignedIn(2);
    const d = await createDraft(a.auth, kind);
    expect((await api().post(`${P}/${d.id}/upload-url`).set(b.auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 10 })).status).toBe(404);
    expect((await api().post(`${P}/${d.id}/complete-upload`).set(b.auth).send({ durationSeconds: 10 })).status).toBe(404);
    expect((await api().post(`${P}/${d.id}/publish`).set(b.auth).send({})).status).toBe(404);
  });

  it('vérifie auprès du stockage avant de confirmer l’envoi', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    const complete = (b: object = { durationSeconds: 20, width: 720, height: 1280 }) => api().post(`${P}/${d.id}/complete-upload`).set(auth).send(b);
    expect((await complete()).body.error.code).toBe('NO_UPLOAD'); // aucune URL demandée
    const up = await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5000 });
    expect((await complete()).body.error.code).toBe('UPLOAD_MISSING'); // URL demandée mais fichier jamais envoyé
    memStore.put(up.body.upload.key, 5000, 'video/mp4');
    const ok = await complete();
    expect(ok.status).toBe(200);
    expect(ok.body[K]).toMatchObject({ uploaded: true, durationSeconds: 20 });
    expect(JSON.stringify(ok.body)).not.toContain(up.body.upload.key); // la clé d'objet n'est jamais exposée dans le contenu
  });

  it('rejette et purge un fichier vide ou plus gros que prévu', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    const up = await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5000 });
    memStore.put(up.body.upload.key, 0, 'video/mp4');
    const res = await api().post(`${P}/${d.id}/complete-upload`).set(auth).send({ durationSeconds: 20 });
    expect(res.status).toBe(400);
    expect(memStore.objects.has(up.body.upload.key)).toBe(false);
    expect((await api().post(`${P}/${d.id}/publish`).set(auth).send({})).body.error.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('valide la durée et les dimensions envoyées', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    const up = await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5000 });
    memStore.put(up.body.upload.key, 5000, 'video/mp4');
    for (const bad of [{}, { durationSeconds: 0 }, { durationSeconds: 1.5 }, { durationSeconds: 'x' }, { durationSeconds: 10, width: -1 }]) {
      expect((await api().post(`${P}/${d.id}/complete-upload`).set(auth).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('prend en compte une miniature, et ignore une miniature jamais envoyée', async () => {
    const { auth } = await creatorSignedIn(1);
    const withThumb = await uploadedDraft(auth, kind, {}, { withThumbnail: true });
    expect(withThumb.thumbnailUrl).toMatch(/^memory:\/\/read\/.+thumb-.+\.png$/);

    const d = await createDraft(auth, kind);
    await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'thumbnail', contentType: 'image/png', sizeBytes: 1000 }); // jamais envoyée
    const v = await api().post(`${P}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5000 });
    memStore.put(v.body.upload.key, 5000, 'video/mp4');
    const done = await api().post(`${P}/${d.id}/complete-upload`).set(auth).send({ durationSeconds: 20, width: 720, height: 1280 });
    expect(done.body[K].thumbnailUrl).toBeNull();
  });

  it('publie uniquement un fichier confirmé, et fige le fichier après publication', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, kind);
    expect((await api().post(`${P}/${d.id}/publish`).set(auth).send({})).status).toBe(409);
    const pub = await publishedContent(auth, kind);
    expect(pub).toMatchObject({ status: 'PUBLISHED' });
    expect(pub.publishedAt).toBeTruthy();
    const again = await api().post(`${P}/${pub.id}/publish`).set(auth).send({});
    expect(again.status).toBe(200); // idempotent
    expect(again.body[K].publishedAt).toBe(pub.publishedAt);
    const replace = await api().post(`${P}/${pub.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 100 });
    expect(replace.body.error.code).toBe('ALREADY_PUBLISHED');
    const thumb = await api().post(`${P}/${pub.id}/upload-url`).set(auth).send({ file: 'thumbnail', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(thumb.status).toBe(200); // la miniature reste modifiable
  });

  it('suppression : le contenu disparaît et ses fichiers sont purgés du stockage', async () => {
    const { auth } = await creatorSignedIn(1);
    const pub = await publishedContent(auth, kind, {}, { withThumbnail: true });
    expect(memStore.objects.size).toBe(2);
    expect((await api().delete(`${P}/${pub.id}`).set(auth)).status).toBe(204);
    expect(memStore.objects.size).toBe(0);
    expect((await api().get(`${P}/${pub.id}`).set(auth)).status).toBe(404);
    expect((await api().get(`${P}/mine`).set(auth)).body.items).toHaveLength(0);
    expect((await api().delete(`${P}/${pub.id}`).set(auth)).status).toBe(404);
    const row = await prisma.video.findUnique({ where: { id: pub.id } }) ?? await prisma.short.findUnique({ where: { id: pub.id } });
    expect(row?.status).toBe('REMOVED'); // suppression douce
  });
});

describe('Shorts : règles propres', () => {
  it('refuse un Short trop long ou horizontal', async () => {
    const { auth } = await creatorSignedIn(1);
    const d = await createDraft(auth, 'SHORT');
    const up = await api().post(`/api/shorts/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5000 });
    memStore.put(up.body.upload.key, 5000, 'video/mp4');
    const long = await api().post(`/api/shorts/${d.id}/complete-upload`).set(auth).send({ durationSeconds: 61, width: 720, height: 1280 });
    expect(long.body.error.code).toBe('SHORT_TOO_LONG');
    const wide = await api().post(`/api/shorts/${d.id}/complete-upload`).set(auth).send({ durationSeconds: 30, width: 1280, height: 720 });
    expect(wide.body.error.code).toBe('SHORT_NOT_VERTICAL');
    const ok = await api().post(`/api/shorts/${d.id}/complete-upload`).set(auth).send({ durationSeconds: 60, width: 720, height: 1280 });
    expect(ok.status).toBe(200);
  });

  it('une vidéo longue n’a pas ces limites, et les deux types sont séparés', async () => {
    const { auth } = await creatorSignedIn(1);
    const v = await uploadedDraft(auth, 'VIDEO');
    expect(v.durationSeconds).toBe(600);
    expect((await api().get(`/api/shorts/${v.id}`).set(auth)).status).toBe(404); // un id de vidéo n'ouvre pas un Short
  });
});

describe('visibilité et accès', () => {
  it('brouillon et privé : invisibles aux autres ; non répertorié : accessible par lien ; public : accessible', async () => {
    const owner = await creatorSignedIn(1);
    const other = await signedIn(2);
    const draft = await createDraft(owner.auth);
    const priv = await publishedContent(owner.auth, 'VIDEO', { visibility: 'PRIVATE' });
    const unlisted = await publishedContent(owner.auth, 'VIDEO', { visibility: 'UNLISTED' });
    const pub = await publishedContent(owner.auth);
    const get = (id: string, a: { Authorization: string }) => api().get(`/api/videos/${id}`).set(a);
    expect((await get(draft.id, owner.auth)).status).toBe(200);
    expect((await get(draft.id, other.auth)).status).toBe(404);
    expect((await get(priv.id, owner.auth)).status).toBe(200);
    expect((await get(priv.id, other.auth)).status).toBe(404);
    expect((await get(unlisted.id, other.auth)).status).toBe(200);
    expect((await get(pub.id, other.auth)).status).toBe(200);
    expect((await get(pub.id, other.auth)).body.video.viewer).toEqual({ liked: false, followsAuthor: false, isOwner: false });
  });

  it('l’auteur qui vous a bloqué devient invisible ; l’auteur suspendu aussi', async () => {
    const owner = await creatorSignedIn(1);
    const viewer = await signedIn(2);
    const pub = await publishedContent(owner.auth);
    expect((await api().get(`/api/videos/${pub.id}`).set(viewer.auth)).status).toBe(200);
    await api().post(`/api/users/${viewer.user.id}/block`).set(owner.auth).send({});
    expect((await api().get(`/api/videos/${pub.id}`).set(viewer.auth)).status).toBe(404);
    await api().delete(`/api/users/${viewer.user.id}/block`).set(owner.auth);
    expect((await api().get(`/api/videos/${pub.id}`).set(viewer.auth)).status).toBe(200);
    await prisma.user.update({ where: { id: owner.user.id }, data: { status: 'SUSPENDED' } });
    expect((await api().get(`/api/videos/${pub.id}`).set(viewer.auth)).status).toBe(404);
  });

  it('lecture : URL délivrée seulement à qui peut voir le contenu', async () => {
    const owner = await creatorSignedIn(1);
    const other = await signedIn(2);
    const draft = await createDraft(owner.auth);
    expect((await api().get(`/api/videos/${draft.id}/playback`).set(owner.auth)).body.error.code).toBe('NOT_READY');
    const pub = await publishedContent(owner.auth);
    const res = await api().get(`/api/videos/${pub.id}/playback`).set(other.auth);
    expect(res.status).toBe(200);
    expect(res.body.playback.url).toMatch(/^memory:\/\/private\/videos\//);
    expect(res.body.playback.mimeType).toBe('video/mp4');
    const priv = await publishedContent(owner.auth, 'VIDEO', { visibility: 'PRIVATE' });
    expect((await api().get(`/api/videos/${priv.id}/playback`).set(other.auth)).status).toBe(404);
  });

  it('téléchargement contrôlé : interdit par défaut, autorisé par le créateur', async () => {
    const owner = await creatorSignedIn(1);
    const other = await signedIn(2);
    const pub = await publishedContent(owner.auth);
    const dl = () => api().get(`/api/videos/${pub.id}/download-url`).set(other.auth);
    expect((await dl()).body.error.code).toBe('DOWNLOAD_NOT_ALLOWED');
    expect((await api().get(`/api/videos/${pub.id}`).set(other.auth)).body.video.allowDownload).toBe(false);
    await api().patch(`/api/videos/${pub.id}`).set(owner.auth).send({ allowDownload: true });
    const res = await dl();
    expect(res.status).toBe(200);
    expect(res.body.download.url).toMatch(/^memory:\/\/download\/videos\/.+filename=Mon%20contenu\.mp4$/);
    await api().patch(`/api/videos/${pub.id}`).set(owner.auth).send({ allowDownload: false });
    expect((await dl()).status).toBe(403);
  });
});
