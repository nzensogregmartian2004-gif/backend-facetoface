import { describe, expect, it } from 'vitest';
import { calculateCoinSplit } from '../src/modules/coins/coins.service';

describe('Step 8 — coins', () => {
  it('applique la commission 20/80 sans perte', () => {
    expect(calculateCoinSplit(1000)).toEqual({ grossAmount: 1000, platformFee: 200, creatorAmount: 800 });
  });
  it('conserve tous les coins dans la transaction économique', () => {
    const split = calculateCoinSplit(333);
    expect(split.platformFee + split.creatorAmount).toBe(split.grossAmount);
  });
});
