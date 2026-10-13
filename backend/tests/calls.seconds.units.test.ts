import { describe, expect, it } from 'vitest';
import { billSeconds } from '../src/modules/calls/calls.billing';

describe('billSeconds — décompte à la seconde', () => {
  it('90 s à 500 F la minute : 750 F, dont 150 F de commission et 600 F pour le créateur', () => {
    expect(billSeconds(500, 90, 10, 2000)).toEqual({ consumedSeconds: 90, consumedAmount: 750, commissionAmount: 150, creatorAmount: 600 });
  });
  it('sous le seuil facturable : rien n’est débité', () => {
    expect(billSeconds(500, 5, 10, 2000)).toEqual({ consumedSeconds: 0, consumedAmount: 0, commissionAmount: 0, creatorAmount: 0 });
  });
  it('invariant : montant = commission + créateur', () => {
    for (const s of [10, 37, 61, 600, 1799]) {
      const b = billSeconds(333, s, 10, 2000);
      expect(b.consumedAmount).toBe(b.commissionAmount + b.creatorAmount);
    }
  });
  it('une durée facturable vaut au moins 1 F', () => {
    expect(billSeconds(1, 10, 10, 2000).consumedAmount).toBeGreaterThanOrEqual(1);
  });
});
