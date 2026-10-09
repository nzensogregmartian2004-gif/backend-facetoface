import { describe, expect, it } from 'vitest';
import { DISAPPEARING_MAX_SECONDS, isValidDisappearingSeconds } from '../src/modules/messages/messages.schemas';

describe('messages éphémères : durées acceptées', () => {
  it('désactivé, ou un nombre entier de jours de 1 à 365', () => {
    expect(isValidDisappearingSeconds(0)).toBe(true);
    expect(isValidDisappearingSeconds(86_400)).toBe(true);
    expect(isValidDisappearingSeconds(90 * 86_400)).toBe(true);
    expect(isValidDisappearingSeconds(DISAPPEARING_MAX_SECONDS)).toBe(true);
    for (const bad of [-1, 3_600, 86_401, 129_600, DISAPPEARING_MAX_SECONDS + 86_400, 1.5, Number.NaN]) {
      expect(isValidDisappearingSeconds(bad)).toBe(false);
    }
  });
});
