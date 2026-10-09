import { beforeEach, describe, expect, it } from 'vitest';
import { objectStorage } from '../src/utils/objectStorage';
import { api, basePath, creatorSignedIn, memStore, publishedContent, resetDb, signedIn, type Kind } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const C = '/api/comments';

/** Envoi simulé d'un vocal : URL signée → « PUT » direct → clé prête à rattacher à un commentaire. */
async function audio(a: S, kind: Kind, targetId: string, contentType = 'audio/mp4', size = 40_000) {
  const r = await api().post(`${C}/upload-url`).set(a.auth).send({ targetType: kind, targetId, contentType, sizeBytes: size });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  memStore.put(r.body.upload.key, size, contentType);
  return r.body.upload.key as string;
}
const comment = (a: S, kind: Kind, id: string, body: Record<string, unknown>) => api().post(`${basePath(kind)}/${id}/comments`).set(a.auth).send(body);
const list = async (a: S, kind: Kind, id: string) => (await api().get(`${basePath(kind)}/${id}/comments`).set(a.auth)).body.items as any[];

describe('commentaires vocaux (Shorts et vidéos longues)', () => {
  it('un vocal est publié sur un Short et sur une vidéo longue, relu avec son URL signée et sa durée', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    for (const kind of ['SHORT', 'VIDEO'] as Kind[]) {
      const content = await publishedContent(author.auth, kind);
      const key = await audio(fan, kind, content.id);
      const r = await comment(fan, kind, content.id, { audioKey: key, durationMs: 12_345 });
      expect(r.status).toBe(201);
      expect(r.body.comment).toMatchObject({ text: null, audio: { mimeType: 'audio/mp4', durationMs: 12_345 } });
      expect(r.body.comment.audio.url).toBeTruthy();
      const items = await list(author, kind, content.id);
      expect(items[0].audio).toMatchObject({ durationMs: 12_345 });
    }
  });

  it('un commentaire est soit du texte, soit un vocal : les deux, ou aucun des deux, sont refusés', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const content = await publishedContent(author.auth, 'SHORT');
    const key = await audio(fan, 'SHORT', content.id);
    expect((await comment(fan, 'SHORT', content.id, { text: 'bonjour', audioKey: key, durationMs: 1000 })).status).toBe(400);
    expect((await comment(fan, 'SHORT', content.id, {})).status).toBe(400);
    expect((await comment(fan, 'SHORT', content.id, { text: '   ' })).status).toBe(400);
  });

  it('un commentaire texte reste inchangé (non-régression)', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const content = await publishedContent(author.auth, 'SHORT');
    const r = await comment(fan, 'SHORT', content.id, { text: 'super' });
    expect(r.status).toBe(201);
    expect(r.body.comment).toMatchObject({ text: 'super', audio: null });
  });

  it('formats : M4A, AAC et MP3 acceptés ; une image est refusée', async () => {
    const fan = await signedIn(2); const author = await creatorSignedIn(1);
    const content = await publishedContent(author.auth, 'SHORT');
    for (const ct of ['audio/mp4', 'audio/aac', 'audio/mpeg']) {
      const r = await api().post(`${C}/upload-url`).set(fan.auth).send({ targetType: 'SHORT', targetId: content.id, contentType: ct, sizeBytes: 1000 });
      expect(r.status).toBe(200);
    }
    const img = await api().post(`${C}/upload-url`).set(fan.auth).send({ targetType: 'SHORT', targetId: content.id, contentType: 'image/png', sizeBytes: 1000 });
    expect(img.status).toBe(400);
    expect(img.body.error.code).toBe('UNSUPPORTED_AUDIO');
  });

  it('taille maximale : au-delà, la demande d’envoi est refusée', async () => {
    const fan = await signedIn(2); const author = await creatorSignedIn(1);
    const content = await publishedContent(author.auth, 'SHORT');
    const r = await api().post(`${C}/upload-url`).set(fan.auth).send({ targetType: 'SHORT', targetId: content.id, contentType: 'audio/mp4', sizeBytes: 21 * 1024 * 1024 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('un fichier ne se réutilise pas, n’appartient qu’à son auteur, et doit avoir été reçu', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2); const other = await signedIn(3);
    const content = await publishedContent(author.auth, 'SHORT');
    const key = await audio(fan, 'SHORT', content.id);
    expect((await comment(fan, 'SHORT', content.id, { audioKey: key, durationMs: 1000 })).status).toBe(201);
    const again = await comment(fan, 'SHORT', content.id, { audioKey: key, durationMs: 1000 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUDIO_ALREADY_USED');
    const stolen = await comment(other, 'SHORT', content.id, { audioKey: key, durationMs: 1000 });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error.code).toBe('INVALID_AUDIO');
    const missing = `comments/${fan.user.id}/absent.m4a`;
    const notReceived = await comment(fan, 'SHORT', content.id, { audioKey: missing, durationMs: 1000 });
    expect(notReceived.status).toBe(409);
    expect(notReceived.body.error.code).toBe('UPLOAD_MISSING');
  });

  it('supprimer son vocal efface le fichier', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const content = await publishedContent(author.auth, 'SHORT');
    const key = await audio(fan, 'SHORT', content.id);
    const c = (await comment(fan, 'SHORT', content.id, { audioKey: key, durationMs: 1000 })).body.comment;
    expect(await objectStorage.head(key)).not.toBeNull();
    expect((await api().delete(`${C}/${c.id}`).set(fan.auth)).status).toBe(204);
    expect(await objectStorage.head(key)).toBeNull();
    expect((await list(author, 'SHORT', content.id)).find((x) => x.id === c.id)).toBeUndefined();
  });

  it('contenu inconnu : pas de demande d’envoi (404)', async () => {
    const fan = await signedIn(2);
    const r = await api().post(`${C}/upload-url`).set(fan.auth).send({ targetType: 'SHORT', targetId: 'inconnu', contentType: 'audio/mp4', sizeBytes: 1000 });
    expect(r.status).toBe(404);
  });
});
