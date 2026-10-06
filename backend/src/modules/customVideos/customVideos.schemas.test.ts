import { describe, expect, it } from 'vitest';
import { offerSchema, requestSchema } from './customVideos.schemas';

describe('custom video schemas', () => {
  it('accepts a request description', () => expect(requestSchema.safeParse({ requestText: 'Une vidéo personnalisée pour mon anniversaire' }).success).toBe(true));
  it('rejects an invalid price', () => expect(offerSchema.safeParse({ priceFcfa: 0, deadlineDays: 3 }).success).toBe(false));
  it('accepts a valid offer', () => expect(offerSchema.safeParse({ priceFcfa: 15000, deadlineDays: 7 }).success).toBe(true));
});
