import { describe, expect, it } from 'vitest';
import { featuredSchema } from '../src/modules/users/channel.schemas';

describe('featuredSchema', () => {
  it('accepte le retrait de la mise en avant', () => {
    expect(featuredSchema.safeParse({ contentId: null }).success).toBe(true);
  });
  it('accepte un contenu avec son type', () => {
    expect(featuredSchema.safeParse({ type: 'VIDEO', contentId: 'abc' }).success).toBe(true);
    expect(featuredSchema.safeParse({ type: 'SHORT', contentId: 'abc' }).success).toBe(true);
  });
  it('refuse un contenu sans type', () => {
    expect(featuredSchema.safeParse({ contentId: 'abc' }).success).toBe(false);
  });
  it('refuse un type inconnu et les champs en trop', () => {
    expect(featuredSchema.safeParse({ type: 'LIVE', contentId: 'abc' }).success).toBe(false);
    expect(featuredSchema.safeParse({ contentId: null, isCertified: true }).success).toBe(false);
  });
});
