import { describe, expect, it } from 'vitest';
import { searchQuerySchema } from '../src/modules/search/search.schemas';

// Recherche de Lives : validation du schéma uniquement (la requête SQL est couverte par les tests d'intégration).
describe('recherche de Lives — schéma', () => {
  it('accepte le type lives avec un mot-clé', () => {
    const r = searchQuerySchema.safeParse({ type: 'lives', q: 'gabon' });
    expect(r.success).toBe(true);
  });

  it('accepte le type lives sans mot-clé (liste des Lives en cours)', () => {
    const r = searchQuerySchema.safeParse({ type: 'lives' });
    expect(r.success).toBe(true);
  });

  it('refuse un filtre de catégorie pour les Lives', () => {
    const r = searchQuerySchema.safeParse({ type: 'lives', q: 'a', category: 'music' });
    expect(r.success).toBe(false);
  });

  it('les vidéos et Shorts gardent l’exigence d’un mot-clé ou d’une catégorie', () => {
    expect(searchQuerySchema.safeParse({ type: 'videos' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ type: 'shorts', q: 'x' }).success).toBe(true);
  });

  it('un type inconnu reste refusé', () => {
    expect(searchQuerySchema.safeParse({ type: 'podcasts', q: 'x' }).success).toBe(false);
  });
});
