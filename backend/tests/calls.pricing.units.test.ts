import { describe, expect, it } from 'vitest';
import { callSettingsSchema } from '../src/modules/calls/calls.schemas';

describe('tarification des appels', () => {
  it('accepte la facturation à la minute', () => {
    expect(callSettingsSchema.safeParse({ pricingMode: 'PER_MINUTE' }).success).toBe(true);
  });
  it('refuse la tarification à la session, avec un message explicite', () => {
    const r = callSettingsSchema.safeParse({ pricingMode: 'PER_SESSION' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain('à la minute');
  });
});
