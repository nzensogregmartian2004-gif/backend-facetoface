import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WithdrawalStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildEligibilityDetails } from '../src/modules/monetization/eligibility.service';
import { buildRevenueSummary } from '../src/modules/monetization/creatorRevenue.service';

describe('étape 6 — revenus du créateur', () => {
  it('additionne les lignes cadeaux et pourboires, et le brut vaut commission plus net', () => {
    const r = buildRevenueSummary('30d', { count: 2, gross: 100, commission: 20, net: 80 }, { count: 1, gross: 50, commission: 10, net: 40 });
    expect(r.total).toEqual({ count: 3, gross: 150, commission: 30, net: 120 });
    expect(r.consistent).toBe(true);
  });
  it('signale une incohérence entre brut, commission et net', () => {
    const r = buildRevenueSummary('7d', { count: 1, gross: 100, commission: 20, net: 70 }, { count: 0, gross: 0, commission: 0, net: 0 });
    expect(r.consistent).toBe(false);
  });
  it('une période vide donne des totaux nuls et reste cohérente', () => {
    const r = buildRevenueSummary('12m', { count: 0, gross: 0, commission: 0, net: 0 }, { count: 0, gross: 0, commission: 0, net: 0 });
    expect(r.total.count).toBe(0);
    expect(r.consistent).toBe(true);
  });
});

describe('étape 6 — détail de l’éligibilité', () => {
  it('donne, pour chaque critère chiffré, le seuil exigé et la valeur actuelle', () => {
    const d = buildEligibilityDetails(
      { subscribers: false, watchTime: true, verified: false },
      { subscribers: { required: 500, current: 120 }, watchTime: { required: 3600, current: 7200 } },
    );
    expect(d).toEqual([
      { key: 'subscribers', met: false, required: 500, current: 120 },
      { key: 'watchTime', met: true, required: 3600, current: 7200 },
      { key: 'verified', met: false, required: null, current: null },
    ]);
  });
});

describe('étape 6 — statuts de retrait visibles dans l’interface', () => {
  it('chaque statut de retrait de la base a un libellé en français et en anglais', () => {
    const fr = readFileSync(resolve('../mobile/src/i18n/fr.ts'), 'utf8');
    const en = readFileSync(resolve('../mobile/src/i18n/en.ts'), 'utf8');
    for (const status of Object.values(WithdrawalStatus)) {
      expect(fr, `status.${status} absent du français`).toContain(`'status.${status}':`);
      expect(en, `status.${status} absent de l'anglais`).toContain(`'status.${status}':`);
    }
  });
});
