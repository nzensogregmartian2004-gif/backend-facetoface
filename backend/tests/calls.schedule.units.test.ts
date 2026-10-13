import { describe, expect, it } from 'vitest';
import { scheduleWindowError } from '../src/modules/calls/schedule.rules';

const now = new Date('2026-10-10T10:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);

describe('fenêtre d’un appel planifié', () => {
  it('accepte un créneau dans 2 heures pour 30 minutes', () => {
    expect(scheduleWindowError(at(120), 30, now)).toBeNull();
  });
  it('refuse un créneau trop proche (moins de 10 minutes)', () => {
    expect(scheduleWindowError(at(5), 30, now)).toBe('TOO_SOON');
  });
  it('refuse un créneau au-delà de 60 jours', () => {
    expect(scheduleWindowError(at(61 * 24 * 60), 30, now)).toBe('TOO_FAR');
  });
  it('refuse une durée hors de 5 à 120 minutes', () => {
    expect(scheduleWindowError(at(120), 4, now)).toBe('DURATION');
    expect(scheduleWindowError(at(120), 121, now)).toBe('DURATION');
  });
});
