import { describe, expect, it } from 'vitest';
import { splitAmount } from '../src/utils/money';
import { isCurrencyCode, normalizeCurrency } from '../src/modules/monetization/currency';

describe('Step 7 — monetization money rules', () => {
  it('applique 20/80 sans perte', () => {
    const x = splitAmount(10_000, 2_000);
    expect(x.platformFeeAmount).toBe(2_000);
    expect(x.creatorAmount).toBe(8_000);
    expect(x.platformFeeAmount + x.creatorAmount).toBe(x.grossAmount);
  });

  it('accepte des codes ISO 4217 de trois lettres sans liste fermée', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('NGN')).toBe(true);
    expect(isCurrencyCode('XAF')).toBe(true);
    expect(isCurrencyCode('EURO')).toBe(false);
  });

  it('arrondit la commission fractionnaire et refuse zéro', () => {
    expect(splitAmount(333, 2_000).platformFeeAmount).toBe(67);
    expect(splitAmount(333, 2_000).creatorAmount).toBe(266);
    expect(() => splitAmount(0, 2_000)).toThrow();
  });

  it('refuse une commission hors limites', () => {
    expect(() => splitAmount(100, 10_001)).toThrow();
  });
});
