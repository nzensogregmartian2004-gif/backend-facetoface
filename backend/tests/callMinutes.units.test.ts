import { describe, expect, it } from 'vitest';
import { minuteAmount } from '../src/modules/calls/callMinutes.service';

describe('minutes d’appel : montant d’une durée', () => {
  it('30 secondes à 1 000 F la minute font 500 F', () => {
    expect(minuteAmount(1000, 30)).toBe(500);
  });
  it('une minute à 1 000 F fait 1 000 F', () => {
    expect(minuteAmount(1000, 60)).toBe(1000);
  });
  it('5 minutes à 500 F la minute font 2 500 F', () => {
    expect(minuteAmount(500, 300)).toBe(2500);
  });
  it('arrondi au franc le plus proche : 20 secondes à 1 000 F', () => {
    expect(minuteAmount(1000, 20)).toBe(333);
  });
});
