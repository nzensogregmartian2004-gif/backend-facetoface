import { describe, expect, it } from 'vitest';
import { transferOwnershipSchema } from '../src/modules/messages/groups.schemas';

describe('passation de la propriété d’un groupe', () => {
  it('exige une confirmation explicite', () => {
    expect(transferOwnershipSchema.safeParse({ userId: 'u1' }).success).toBe(false);
  });
  it('refuse une confirmation qui n’est pas « vrai »', () => {
    expect(transferOwnershipSchema.safeParse({ userId: 'u1', confirm: false }).success).toBe(false);
  });
  it('accepte un destinataire avec confirmation', () => {
    expect(transferOwnershipSchema.safeParse({ userId: 'u1', confirm: true }).success).toBe(true);
  });
  it('refuse un destinataire vide', () => {
    expect(transferOwnershipSchema.safeParse({ userId: '   ', confirm: true }).success).toBe(false);
  });
  it('refuse les champs inconnus', () => {
    expect(transferOwnershipSchema.safeParse({ userId: 'u1', confirm: true, role: 'ADMIN' }).success).toBe(false);
  });
});
