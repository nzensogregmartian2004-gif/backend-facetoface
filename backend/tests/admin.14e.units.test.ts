import { describe, expect, it } from 'vitest';
import { permissionForAdminPath } from '../src/modules/admin/permissions';
import { redactRevenue } from '../src/modules/admin/revenue';

describe('permissions des soldes et de la fraude', () => {
  it('les soldes exigent finance.balances.view, en lecture comme ailleurs', () => {
    expect(permissionForAdminPath('GET', '/balances')).toBe('finance.balances.view');
  });
  it('la fraude reste sous finance.fraud.manage', () => {
    expect(permissionForAdminPath('GET', '/fraud/events')).toBe('finance.fraud.manage');
    expect(permissionForAdminPath('PATCH', '/fraud/users/abc')).toBe('finance.fraud.manage');
  });
});

describe('montants du dashboard', () => {
  const totals = [{ currency: 'XAF', _sum: { grossAmount: 1000 } }];
  const withdrawals = [{ status: 'COMPLETED', _count: { _all: 2 }, _sum: { amount: 5000, fee: 100 } }];

  it('sans finance.revenue.view : aucun montant, seulement les compteurs', () => {
    const r = redactRevenue(false, totals, withdrawals);
    expect(r.totals).toEqual([]);
    expect(r.withdrawals).toEqual([{ status: 'COMPLETED', _count: { _all: 2 } }]);
    expect(JSON.stringify(r)).not.toContain('5000');
  });
  it('avec finance.revenue.view : données inchangées', () => {
    expect(redactRevenue(true, totals, withdrawals)).toEqual({ totals, withdrawals });
  });
});
