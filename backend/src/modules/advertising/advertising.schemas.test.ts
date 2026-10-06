import { describe, expect, it } from 'vitest';
import { createCampaignSchema, impressionSchema } from './advertising.schemas';

describe('advertising schemas', () => {
  it('accepts the required ad formats', () => expect(createCampaignSchema.safeParse({
    name: 'Campagne FR', headline: 'Découvrez Face to Face', currency: 'CAD', budgetAmount: 10000, pricePerImpression: 2,
    formats: ['PRE_ROLL','MID_ROLL','SHORT_BETWEEN','NATIVE','BANNER','INTERSTITIAL','LIVE'], placements: ['HOME_FEED','VIDEO_PLAYER','SHORT_FEED','LIVE_PLAYER','SEARCH','PROFILE'],
    targetLanguages: ['FR','EN'], targetCountries: ['CA'], targetCategories: [], startsAt: '2026-10-01', endsAt: '2026-11-01'
  }).success).toBe(true));
  it('requires an idempotent impression event key', () => expect(impressionSchema.safeParse({ eventKey: 'x', format: 'NATIVE', placement: 'HOME_FEED' }).success).toBe(false));
});
