import { describe, expect, it } from 'vitest';
import { ageOn } from '../src/utils/dates';
import { sniffImage } from '../src/utils/storage';
import { formatRefreshToken, splitRefreshToken } from '../src/utils/tokens';
import { decodeCursor, encodeCursor, readIdCursor, readOffsetCursor } from '../src/utils/cursor';
import { presignUrl, signHeaders } from '../src/utils/s3sign';
import { MemoryStorage, S3Storage } from '../src/utils/objectStorage';
import { WEIGHTS, forYouScore, rank, trendingScore, type RankInput, type Signals } from '../src/modules/feed/ranking';
import { CATEGORIES } from '../src/modules/content/categories';
import { escapeLike } from '../src/utils/like';
import { rankSuggestions, suggestionReason, suggestionScore } from '../src/modules/users/suggestions.ranking';

describe('ageOn', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it('compte les années révolues', () => {
    expect(ageOn(d('2000-06-15'), d('2026-06-14'))).toBe(25);
    expect(ageOn(d('2000-06-15'), d('2026-06-15'))).toBe(26);
    expect(ageOn(d('2008-10-02'), d('2026-10-02'))).toBe(18);
    expect(ageOn(d('2008-10-03'), d('2026-10-02'))).toBe(17);
  });
});

describe('jeton de rafraîchissement', () => {
  it('se découpe en id de session + secret', () => {
    const t = formatRefreshToken('abc', 'sec.ret');
    expect(splitRefreshToken(t)).toEqual({ sessionId: 'abc', secret: 'sec.ret' });
    expect(splitRefreshToken('sans-point')).toBeNull();
    expect(splitRefreshToken('.vide')).toBeNull();
  });
});

describe('sniffImage', () => {
  it('reconnaît JPEG/PNG/WebP et rejette le reste', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(12).fill(0)]))).toBe('jpg');
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)]))).toBe('png');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]))).toBe('webp');
    expect(sniffImage(Buffer.from('GIF89a......................'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg></svg>'))).toBeNull();
  });
});

describe('signature SigV4 (exemples officiels de la documentation S3)', () => {
  const creds = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  const now = new Date('2013-05-24T00:00:00Z');
  it('URL pré-signée', () => {
    const url = presignUrl({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', creds, expiresSeconds: 86400, now });
    expect(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')).toBe(true);
  });
  it('en-tête Authorization', () => {
    const h = signHeaders({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', creds, headers: { range: 'bytes=0-9' }, now });
    expect(h.Authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(h.Authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')).toBe(true);
    expect(h).not.toHaveProperty('host');
  });
  it('signe le type de contenu d’un envoi et encode correctement les clés', () => {
    const s3 = new S3Storage({ region: 'us-east-1', bucket: 'b', accessKey: 'AK', secretKey: 'SK', pathStyle: false });
    const up = s3.presignUpload('videos/abc/source-x.mp4', 'video/mp4', 600);
    expect(up.url.startsWith('https://b.s3.us-east-1.amazonaws.com/videos/abc/source-x.mp4?')).toBe(true);
    expect(up.url).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
    expect(up.url).toContain('X-Amz-Expires=600');
    expect(up.headers).toEqual({ 'Content-Type': 'video/mp4' });
    const path = new S3Storage({ endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'b', accessKey: 'AK', secretKey: 'SK', pathStyle: true });
    expect(path.readUrl('a/b c.mp4')).toContain('http://localhost:9000/b/a/b%20c.mp4?');
    const cdn = new S3Storage({ region: 'us-east-1', bucket: 'b', accessKey: 'AK', secretKey: 'SK', pathStyle: false, cdnUrl: 'https://cdn.example.com/' });
    expect(cdn.readUrl('thumbs/x.png')).toBe('https://cdn.example.com/thumbs/x.png');
    expect(cdn.downloadUrl('v/x.mp4', 'Ma vidéo.mp4')).toContain('response-content-disposition=attachment');
  });
  it('le pilote mémoire conserve les objets', async () => {
    const m = new MemoryStorage();
    expect(await m.head('k')).toBeNull();
    m.put('k', 10, 'video/mp4');
    expect(await m.head('k')).toEqual({ size: 10, contentType: 'video/mp4' });
    await m.delete('k');
    expect(await m.head('k')).toBeNull();
  });
});

describe('curseurs de pagination', () => {
  it('aller-retour et rejet des curseurs invalides', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(readIdCursor(encodeCursor({ i: 'abc' }))).toBe('abc');
    expect(readOffsetCursor(undefined)).toBe(0);
    expect(readOffsetCursor(encodeCursor({ o: 40 }))).toBe(40);
    for (const bad of ['pas-un-curseur', encodeCursor({ i: 12 }), encodeCursor({ x: 1 })]) expect(() => readIdCursor(bad)).toThrow();
    for (const bad of [encodeCursor({ o: -1 }), encodeCursor({ o: 1.5 }), encodeCursor({ o: 'a' }), encodeCursor({ o: 10_000_000 })]) expect(() => readOffsetCursor(bad)).toThrow();
  });
});

describe('classement du feed', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const item = (o: Partial<RankInput> & { id: string }): RankInput => ({ authorId: 'a', category: 'music', publishedAt: hours(10), viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0, ...o });
  const none: Signals = { followedAuthors: new Set(), likedCategories: new Map(), seen: new Set() };

  it('la popularité augmente le score, l’âge le réduit', () => {
    expect(trendingScore(item({ id: '1', viewCount: 100 }), now)).toBeGreaterThan(trendingScore(item({ id: '2' }), now));
    expect(trendingScore(item({ id: '1', likeCount: 10 }), now)).toBeGreaterThan(trendingScore(item({ id: '2', viewCount: 10 }), now)); // un like pèse plus qu'une vue
    expect(trendingScore(item({ id: '1', viewCount: 100, publishedAt: hours(1) }), now)).toBeGreaterThan(trendingScore(item({ id: '2', viewCount: 100, publishedAt: hours(100) }), now));
  });
  it('un contenu publié dans le futur (horloge décalée) ne casse pas le calcul', () => {
    const s = trendingScore(item({ id: '1', publishedAt: new Date(now.getTime() + 3_600_000) }), now);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
  it('« Pour toi » : abonnement, catégorie aimée, contenu déjà vu', () => {
    const base = item({ id: '1' });
    const b = forYouScore(base, now, none);
    expect(forYouScore(base, now, { ...none, followedAuthors: new Set(['a']) })).toBeCloseTo(b * WEIGHTS.followedBoost, 10);
    expect(forYouScore(base, now, { ...none, likedCategories: new Map([['music', 4]]) })).toBeCloseTo(b * (1 + 4 * WEIGHTS.categoryBoostPerLike), 10);
    expect(forYouScore(base, now, { ...none, likedCategories: new Map([['music', 1000]]) })).toBeCloseTo(b * (1 + WEIGHTS.categoryBoostCap), 10); // plafonné
    expect(forYouScore(base, now, { ...none, seen: new Set(['1']) })).toBeCloseTo(b * WEIGHTS.seenPenalty, 10);
  });
  it('les nouveautés reçoivent un bonus de fraîcheur qui s’éteint en 24 h', () => {
    const fresh = forYouScore(item({ id: '1', publishedAt: hours(1) }), now, none);
    const gap = fresh - trendingScore(item({ id: '1', publishedAt: hours(1) }), now);
    expect(gap).toBeCloseTo(WEIGHTS.freshnessBonus * (1 - 1 / WEIGHTS.freshnessHours), 10);
    const old = item({ id: '2', publishedAt: hours(48) });
    expect(forYouScore(old, now, none)).toBeCloseTo(trendingScore(old, now), 10);
  });
  it('trie par score décroissant, départage stable par identifiant', () => {
    const items = [item({ id: 'a' }), item({ id: 'c' }), item({ id: 'b' }), item({ id: 'z', viewCount: 50 })];
    const out = rank(items, (i) => trendingScore(i, now));
    expect(out.map((i) => i.id)).toEqual(['z', 'c', 'b', 'a']);
    expect(rank([...items].reverse(), (i) => trendingScore(i, now)).map((i) => i.id)).toEqual(['z', 'c', 'b', 'a']); // indépendant de l'ordre d'entrée
  });
});

describe('catégories', () => {
  it('identifiants uniques, en minuscules, avec « autre » en dernier', () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((s) => /^[a-z]+$/.test(s))).toBe(true);
    expect(slugs[slugs.length - 1]).toBe('other');
  });
});

describe('suggestions (étape 4)', () => {
  it('amis d’amis > centres d’intérêt > popularité, chaque signal plafonné', () => {
    const base = { followers: 0, mutual: 0, affinity: 0 };
    expect(suggestionScore({ ...base, mutual: 1 })).toBeGreaterThan(suggestionScore({ ...base, affinity: 1 }));
    expect(suggestionScore({ ...base, affinity: 1 })).toBeGreaterThan(suggestionScore({ ...base, followers: 3 }));
    expect(suggestionScore({ ...base, mutual: 5 })).toBe(suggestionScore({ ...base, mutual: 500 }));
    expect(suggestionScore({ ...base, affinity: 4 })).toBe(suggestionScore({ ...base, affinity: 40 }));
    expect(suggestionScore({ ...base, followers: 1_000_000 })).toBeLessThan(15); // logarithmique : un très gros compte n'écrase pas tout
  });
  it('raison : MUTUAL, INTERESTS, sinon POPULAR', () => {
    expect(suggestionReason({ followers: 9, mutual: 2, affinity: 3 })).toBe('MUTUAL');
    expect(suggestionReason({ followers: 9, mutual: 0, affinity: 3 })).toBe('INTERESTS');
    expect(suggestionReason({ followers: 9, mutual: 0, affinity: 0 })).toBe('POPULAR');
  });
  it('classement déterministe, indépendant de l’ordre d’entrée', () => {
    const items = [{ id: 'b', s: 1 }, { id: 'a', s: 1 }, { id: 'c', s: 5 }];
    expect(rankSuggestions(items, (i) => i.s).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(rankSuggestions([...items].reverse(), (i) => i.s).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('recherche (étape 4)', () => {
  it('échappe les jokers LIKE et le caractère d’échappement', () => {
    expect(escapeLike('user_1')).toBe('user\\_1');
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('simple')).toBe('simple');
  });
});
