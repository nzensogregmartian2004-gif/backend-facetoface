import { describe, expect, it } from 'vitest';
import { transactionQuerySchema, withdrawalSchema } from './wallet.schemas';

describe('wallet schemas', () => {
  it('accepts a multi-currency withdrawal', () => expect(withdrawalSchema.parse({ amount: 10000, currency: 'CAD', method: 'BANK_TRANSFER', destination: '****1234' }).currency).toBe('CAD'));
  it('rejects invalid currency', () => expect(() => withdrawalSchema.parse({ amount: 100, currency: 'EURO', method: 'OTHER', destination: 'abcd' })).toThrow());
  it('rejects an excessive transaction limit', () => expect(() => transactionQuerySchema.parse({ limit: 200 })).toThrow());
});
