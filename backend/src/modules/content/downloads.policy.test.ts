import { describe, expect, it } from 'vitest';
import { effectiveDownloadsEnabled } from './downloads.policy';

describe('réglage global des téléchargements', () => {
  it('suit la valeur administrateur quand elle est un booléen', () => {
    expect(effectiveDownloadsEnabled(false, true)).toBe(false);
    expect(effectiveDownloadsEnabled(true, false)).toBe(true);
  });
  it('revient à la variable d’environnement sans valeur administrateur', () => {
    expect(effectiveDownloadsEnabled(undefined, true)).toBe(true);
    expect(effectiveDownloadsEnabled(undefined, false)).toBe(false);
  });
  it('ignore une valeur administrateur non booléenne', () => {
    expect(effectiveDownloadsEnabled('false', true)).toBe(true);
    expect(effectiveDownloadsEnabled(0, false)).toBe(false);
  });
});
