import { describe, expect, it } from 'vitest';
import { isValidStoryHours } from '../src/modules/stories/stories.service';

describe('stories : durée de vie', () => {
  it('nombre entier d’heures entre 1 et le maximum administrable', () => {
    expect(isValidStoryHours(24, 72)).toBe(true);
    expect(isValidStoryHours(1, 72)).toBe(true);
    expect(isValidStoryHours(72, 72)).toBe(true);
    for (const bad of [0, -1, 73, 1.5, Number.NaN]) expect(isValidStoryHours(bad, 72)).toBe(false);
  });
});
