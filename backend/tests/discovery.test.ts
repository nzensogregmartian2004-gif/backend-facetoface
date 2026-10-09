import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { syncContentTags } from '../src/modules/discovery/tags.service';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

/** Vidéo publiée (sans passer par le téléversement) : les tags sont synchronisés comme à la publication. */
async function publishedVideo(authorId: string, title: string, description: string | null = null) {
  const v = await prisma.video.create({
    data: {
      authorId, title, description, category: 'Autres', status: 'PUBLISHED', visibility: 'PUBLIC', processingStatus: 'READY',
      videoKey: `videos/${authorId}.mp4`, uploadedAt: new Date(), durationSeconds: 30, width: 1280, height: 720,
      mimeType: 'video/mp4', publishedAt: new Date(),
    },
  });
  await syncContentTags('VIDEO', v.id);
  return v;
}

describe('étape 12 — découverte (non exécuté ici : base requise)', () => {
  it('un hashtag saisi à la publication mène à une page listant le contenu', async () => {
    const author = await creatorSignedIn(1); const fan = await signedIn(2);
    const v = await publishedVideo(author.user.id, 'Vlog #Gabon', 'Tournage à Libreville');
    const search = await api().get('/api/search/hashtags?q=gab').set(fan.auth);
    expect(search.body.items).toEqual([{ name: 'gabon', count: 1 }]);
    const page = await api().get('/api/search/hashtags/gabon/contents?type=video').set(fan.auth);
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([v.id]);
  });

  it('retirer le hashtag de la description le retire des pages', async () => {
    const author = await creatorSignedIn(1);
    const v = await publishedVideo(author.user.id, 'Vlog', '#gabon');
    await prisma.video.update({ where: { id: v.id }, data: { description: 'sans tag' } });
    await syncContentTags('VIDEO', v.id);
    expect(await prisma.contentHashtag.count({ where: { contentId: v.id } })).toBe(0);
  });

  it('une mention enregistre le compte mentionné, sans l’auteur lui-même', async () => {
    const author = await creatorSignedIn(1); const other = await signedIn(2);
    const v = await publishedVideo(author.user.id, 'Merci @user_2 et @user_1');
    const mentions = await prisma.mention.findMany({ where: { contentId: v.id }, select: { mentionedUserId: true } });
    expect(mentions.map((m) => m.mentionedUserId)).toEqual([other.user.id]);
  });

  it('le feed local ne renvoie que les créateurs du pays demandé', async () => {
    const ga = await creatorSignedIn(1); const fr = await creatorSignedIn(2); const fan = await signedIn(3);
    await prisma.user.update({ where: { id: ga.user.id }, data: { country: 'GA' } });
    await prisma.user.update({ where: { id: fr.user.id }, data: { country: 'FR' } });
    const vGa = await publishedVideo(ga.user.id, 'Gabon');
    await publishedVideo(fr.user.id, 'France');
    const r = await api().get('/api/feed/local?country=GA&type=video').set(fan.auth);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([vGa.id]);
  });

  it('feed local sans pays (ni paramètre, ni pays du compte) : 400 COUNTRY_REQUIRED', async () => {
    const fan = await signedIn(3);
    const r = await api().get('/api/feed/local?type=video').set(fan.auth);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('COUNTRY_REQUIRED');
  });

  it('créateurs populaires : triés par abonnés, profils privés exclus', async () => {
    const a = await creatorSignedIn(1); const b = await creatorSignedIn(2); const fan = await signedIn(3);
    await prisma.user.update({ where: { id: b.user.id }, data: { profileVisibility: 'PRIVATE' } });
    const r = await api().get('/api/users/popular?limit=5').set(fan.auth);
    expect(r.status).toBe(200);
    expect(r.body.items.map((u: { id: string }) => u.id)).toEqual([a.user.id]);
  });
});
