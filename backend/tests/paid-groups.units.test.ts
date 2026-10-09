import { describe, expect, it } from 'vitest';
import { groupUpdateSchema } from '../src/modules/messages/groups.schemas';
import { splitRecord } from '../src/utils/money';

describe('groupes payants : réglages et commission', () => {
  it('prix entier ou null, rien d’autre', () => {
    expect(groupUpdateSchema.safeParse({ entryPrice: 500 }).success).toBe(true);
    expect(groupUpdateSchema.safeParse({ entryPrice: null }).success).toBe(true);
    expect(groupUpdateSchema.safeParse({ entryPrice: 1.5 }).success).toBe(false);
    expect(groupUpdateSchema.safeParse({ entryPrice: '500' }).success).toBe(false);
  });
  it('commission : brut = commission + net, sans perte d’arrondi', () => {
    const s = splitRecord(333, 2000, 'XAF');
    expect(s).toMatchObject({ grossAmount: 333, commissionAmount: 67, creatorAmount: 266 });
    expect(s.commissionAmount + s.creatorAmount).toBe(333);
  });
});
