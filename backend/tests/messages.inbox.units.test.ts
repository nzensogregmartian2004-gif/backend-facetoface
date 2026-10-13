import { describe, expect, it } from 'vitest';
import { inboxQuerySchema } from '../src/modules/messages/messages.schemas';

describe('boîte de messages : filtres et recherche', () => {
  it('accepte les filtres connus et les refuse sinon', () => {
    expect(inboxQuerySchema.parse({ filter: 'unread' }).filter).toBe('unread');
    expect(inboxQuerySchema.parse({ filter: 'groups' }).filter).toBe('groups');
    expect(inboxQuerySchema.safeParse({ filter: 'favoris' }).success).toBe(false);
  });
  it('limite la recherche à 80 caractères', () => {
    expect(inboxQuerySchema.safeParse({ q: 'a'.repeat(80) }).success).toBe(true);
    expect(inboxQuerySchema.safeParse({ q: 'a'.repeat(81) }).success).toBe(false);
  });
  it('sans filtre ni recherche, la liste reste celle d’avant', () => {
    const parsed = inboxQuerySchema.parse({});
    expect(parsed.filter).toBeUndefined();
    expect(parsed.q).toBeUndefined();
  });
});
