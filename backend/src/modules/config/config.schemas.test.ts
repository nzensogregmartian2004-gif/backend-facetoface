import { describe, expect, it } from 'vitest';
import { updateConfigSchema, upsertConfigSchema } from './config.schemas';

describe('step 17 configuration schemas', () => {
  it('accepts a premium price configuration', () => {
    expect(upsertConfigSchema.parse({
      key: 'PREMIUM.MONTHLY_PRICE', value: 9500, type: 'INTEGER', enabled: true,
      description: 'Prix mensuel', defaultValue: 9500, category: 'PREMIUM',
    }).value).toBe(9500);
  });

  it('rejects an invalid configuration key', () => {
    expect(() => upsertConfigSchema.parse({
      key: 'premium monthly price', value: 9500, type: 'INTEGER', enabled: true,
      description: 'Prix', defaultValue: 9500, category: 'PREMIUM',
    })).toThrow();
  });

  it('accepts a partial update with a reason', () => {
    expect(updateConfigSchema.parse({ value: 25, reason: 'Ajustement économique' }).reason).toBe('Ajustement économique');
  });
});
