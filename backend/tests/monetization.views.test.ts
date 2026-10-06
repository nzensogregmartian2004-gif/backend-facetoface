import { describe, expect, it } from 'vitest';
import { allocatePoolAmount, splitAdvertisingRevenue } from '../src/modules/monetization/views.service';

describe('Step 8 — monetisation par les vues', () => {
  it('répartit les revenus publicitaires selon 60/40', () => {
    const x = splitAdvertisingRevenue(1_000_000, 4_000);
    expect(x.platformAmount).toBe(600_000);
    expect(x.creatorPoolAmount).toBe(400_000);
    expect(x.platformShareBps + x.creatorPoolShareBps).toBe(10_000);
  });

  it('distribue tout le pool sans perte d’arrondi', () => {
    const x = allocatePoolAmount(100, [
      { creatorId: 'a', qualifiedViews: 1n },
      { creatorId: 'b', qualifiedViews: 2n },
      { creatorId: 'c', qualifiedViews: 7n },
    ]);
    expect(x.totalQualifiedViews).toBe(10n);
    expect(x.allocations.reduce((n, a) => n + a.amount, 0)).toBe(100);
    expect(x.allocations.find(a => a.creatorId === 'a')?.amount).toBe(10);
    expect(x.allocations.find(a => a.creatorId === 'b')?.amount).toBe(20);
    expect(x.allocations.find(a => a.creatorId === 'c')?.amount).toBe(70);
  });

  it('ne distribue rien sans vue qualifiée', () => {
    const x = allocatePoolAmount(500, []);
    expect(x.totalQualifiedViews).toBe(0n);
    expect(x.allocations).toHaveLength(0);
  });
});
