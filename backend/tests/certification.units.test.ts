import { describe, expect, it } from 'vitest';
import { nextCertificationStatus } from '../src/modules/certification/certification.service';

describe('étape 4 — transitions de certification', () => {
  it('certifie un compte non certifié, quel que soit son statut précédent', () => {
    expect(nextCertificationStatus('NON_CERTIFIED', 'CERTIFY')).toBe('CERTIFIED');
    expect(nextCertificationStatus('PENDING', 'CERTIFY')).toBe('CERTIFIED');
    expect(nextCertificationStatus('REVOKED', 'CERTIFY')).toBe('CERTIFIED');
  });
  it('refuse de certifier un compte déjà certifié', () => {
    expect(() => nextCertificationStatus('CERTIFIED', 'CERTIFY')).toThrow();
  });
  it('révoque un compte certifié', () => {
    expect(nextCertificationStatus('CERTIFIED', 'REVOKE')).toBe('REVOKED');
  });
  it('refuse de révoquer un compte qui n’est pas certifié', () => {
    expect(() => nextCertificationStatus('NON_CERTIFIED', 'REVOKE')).toThrow();
    expect(() => nextCertificationStatus('REVOKED', 'REVOKE')).toThrow();
  });
});
