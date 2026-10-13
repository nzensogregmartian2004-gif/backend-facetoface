import { describe, expect, it } from 'vitest';
import { extractUrls } from '../src/modules/messages/messages.links';
import { sharedQuerySchema } from '../src/modules/messages/messages.schemas';

describe('liens partagés', () => {
  it('extrait les liens sans la ponctuation finale, sans doublon', () => {
    expect(extractUrls('voir https://a.com/x, et http://b.org. encore https://a.com/x')).toEqual(['https://a.com/x', 'http://b.org']);
  });
  it('un texte sans lien donne une liste vide', () => {
    expect(extractUrls('bonjour')).toEqual([]);
  });
});

describe('requête des médias et liens partagés', () => {
  it('accepte media et links, et refuse les autres types', () => {
    expect(sharedQuerySchema.parse({ kind: 'media' }).kind).toBe('media');
    expect(sharedQuerySchema.safeParse({ kind: 'documents' }).success).toBe(false);
  });
});
