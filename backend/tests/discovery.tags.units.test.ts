import { describe, expect, it } from 'vitest';
import { MAX_TAGS_PER_CONTENT, extractHashtags, extractMentions, normalizeTag } from '../src/modules/discovery/tags';
import { hashtagQuerySchema } from '../src/modules/discovery/discovery.schemas';

describe('étape 12 — hashtags', () => {
  it('extrait les hashtags en minuscules, sans doublon, dans l’ordre d’apparition', () => {
    expect(extractHashtags('Trop bien #Gabon à #Libreville, #gabon !')).toEqual(['gabon', 'libreville']);
  });
  it('accepte les lettres accentuées et les chiffres après la première lettre', () => {
    expect(extractHashtags('#Été2026 #café_bon')).toEqual(['été2026', 'café_bon']);
  });
  it('normalise Unicode : forme composée et décomposée donnent le même tag', () => {
    const composed = 'é'; const decomposed = 'e\u0301';
    expect(normalizeTag(`#${composed}t${composed}`.toUpperCase())).toBe(normalizeTag(`#${decomposed}t${decomposed}`.toUpperCase()));
  });
  it('ignore les nombres seuls, les tags trop courts et les # isolés', () => {
    expect(extractHashtags('# #a #2026 ##gabon')).toEqual(['gabon']);
  });
  it('ne prend pas un # collé à un mot (ex. numéro, couleur)', () => {
    expect(extractHashtags('N°#12 code&#gabon')).toEqual([]);
  });
  it('limite le nombre de hashtags par contenu', () => {
    const text = Array.from({ length: 25 }, (_, i) => `#tag${String.fromCharCode(97 + i)}`).join(' ');
    expect(extractHashtags(text)).toHaveLength(MAX_TAGS_PER_CONTENT);
  });
  it('requête de recherche : # initial retiré, minuscules', () => {
    expect(hashtagQuerySchema.parse({ q: '#GAB' }).q).toBe('gab');
    expect(hashtagQuerySchema.parse({}).q).toBeUndefined();
  });
});

describe('étape 12 — mentions', () => {
  it('extrait les pseudos mentionnés en minuscules', () => {
    expect(extractMentions('Merci @Marie.K et @jean_01 !')).toEqual(['marie.k', 'jean_01']);
  });
  it('ignore les adresses e-mail et les @ doublés', () => {
    expect(extractMentions('écrivez à contact@exemple.com ou @@marie')).toEqual([]);
  });
  it('ignore les pseudos trop courts et le point final collé au pseudo', () => {
    expect(extractMentions('@ab @marie. @x')).toEqual(['marie']);
  });
});
