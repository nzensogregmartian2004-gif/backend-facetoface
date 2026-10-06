import { describe, expect, it } from 'vitest';
import { configVersionListSchema, restoreDefaultsSchema, updateConfigSchema, upsertConfigSchema } from './config.schemas';
import { formatRuleVersion } from './config.service';

describe('configuration versioning contracts', () => {
  it('formats immutable rule versions consistently', () => {
    expect(formatRuleVersion(1)).toBe('CFG-000001');
    expect(formatRuleVersion(42)).toBe('CFG-000042');
    expect(formatRuleVersion(1234567)).toBe('CFG-1234567');
  });

  it('requires a reason for configuration mutations', () => {
    expect(() => updateConfigSchema.parse({ value: 10 })).toThrow();
    expect(() => upsertConfigSchema.parse({
      key: 'COMMISSION.PLATFORM_PERCENT', value: 20, type: 'DECIMAL', enabled: true,
      description: 'Commission', defaultValue: 20, category: 'COMMISSION',
    })).toThrow();
  });

  it('accepts version history filters and bounded pagination', () => {
    expect(configVersionListSchema.parse({ key: 'COMMISSION.PLATFORM_PERCENT', version: '12', limit: '25' })).toEqual({
      key: 'COMMISSION.PLATFORM_PERCENT', version: 12, limit: 25,
    });
    expect(() => configVersionListSchema.parse({ limit: 0 })).toThrow();
  });

  it('requires explicit confirmation before restoring defaults', () => {
    expect(restoreDefaultsSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(() => restoreDefaultsSchema.parse({ confirm: false })).toThrow();
  });
});
