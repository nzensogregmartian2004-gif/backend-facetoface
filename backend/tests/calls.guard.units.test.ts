import { describe, expect, it } from 'vitest';
import { assertCallsConfigured } from '../src/utils/callsGuard';
import { AppError } from '../src/utils/errors';

describe('garde de configuration des appels', () => {
  it('ne fait rien quand le fournisseur est configuré', () => {
    expect(() => assertCallsConfigured(true)).not.toThrow();
  });
  it('refuse avec un 503 et un code stable quand il ne l’est pas', () => {
    try {
      assertCallsConfigured(false);
      throw new Error('aurait dû lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(503);
      expect((e as AppError).code).toBe('CALLS_NOT_CONFIGURED');
    }
  });
});
