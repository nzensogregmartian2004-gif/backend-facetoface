import { describe, expect, it } from 'vitest';
import { favoriteSchema, inboxQuerySchema } from '../src/modules/messages/messages.schemas';

describe('favoris de conversation', () => {
  it('le filtre favoris est accepté par la boîte de messages', () => {
    expect(inboxQuerySchema.parse({ filter: 'favorites' }).filter).toBe('favorites');
  });
  it('la mise en favori exige un booléen, pas une chaîne', () => {
    expect(favoriteSchema.safeParse({ favorite: true }).success).toBe(true);
    expect(favoriteSchema.safeParse({ favorite: 'true' }).success).toBe(false);
    expect(favoriteSchema.safeParse({}).success).toBe(false);
  });
});
