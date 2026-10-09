import { describe, expect, it } from 'vitest';
import { planSchema, subscribeSchema } from './subscriptions.schemas';

describe('creator subscriptions schemas', () => {
  it('accepts a valid creator plan', () => {
    const r = planSchema.safeParse({ price: 5000, benefits: { exclusiveContent: true, privateLives: true, directMessages: true, subscriberCalls: false, includedCallMinutes: 0, downloads: true, other: ['Badge'] } });
    expect(r.success).toBe(true);
  });
  it('rejects malformed payment details', () => {
    expect(subscribeSchema.safeParse({ operator: 'OTHER', phone: 'x' }).success).toBe(false);
  });
});
