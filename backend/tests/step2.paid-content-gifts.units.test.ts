import { describe, expect, it } from 'vitest';
import { createContentSchema, updateContentSchema } from '../src/modules/content/content.schemas';

describe('étape 2 — contenu payant', () => {
  const base = { title: 'Vidéo test', category: 'other' };

  it('accepte un contenu gratuit sans prix', () => {
    expect(createContentSchema.safeParse(base).success).toBe(true);
  });

  it('exige la devise avec le prix', () => {
    expect(createContentSchema.safeParse({ ...base, price: 200 }).success).toBe(false);
    expect(createContentSchema.safeParse({ ...base, currency: 'XAF' }).success).toBe(false);
  });

  it('accepte le couple prix + devise', () => {
    expect(createContentSchema.safeParse({ ...base, price: 2000, currency: 'XAF' }).success).toBe(true);
    expect(updateContentSchema.safeParse({ price: 500, currency: 'EUR' }).success).toBe(true);
  });
});
