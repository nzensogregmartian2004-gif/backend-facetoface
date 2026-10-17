import { describe, expect, it } from 'vitest';
import { assertNotRestricted } from '../src/utils/restriction';

describe('restriction de compte', () => {
  it('laisse passer un compte non restreint', () => {
    expect(() => assertNotRestricted({ restrictedAt: null })).not.toThrow();
    expect(() => assertNotRestricted({})).not.toThrow();
  });
  it('bloque un compte restreint, avec un code explicite', () => {
    try {
      assertNotRestricted({ restrictedAt: new Date() });
      throw new Error('aurait dû lever une erreur');
    } catch (e: any) {
      expect(e.code ?? e.errorCode ?? e.details?.code ?? JSON.stringify(e)).toContain('ACCOUNT_RESTRICTED');
    }
  });
});
