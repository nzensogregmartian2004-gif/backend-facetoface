import { describe, expect, it } from 'vitest';
import { createCampaignSchema, impressionSchema } from './advertising.schemas';

describe('advertising schemas', () => {
  it('accepts the required ad formats', () => expect(createCampaignSchema.safeParse({
    name: 'Campagne FR', headline: 'Découvrez Face to Face', currency: 'CAD', budgetAmount: 10000, pricePerImpression: 2,
    formats: ['PRE_ROLL','MID_ROLL','SHORT_BETWEEN','NATIVE','BANNER','INTERSTITIAL','LIVE'], placements: ['HOME_FEED','VIDEO_PLAYER','SHORT_FEED','LIVE_PLAYER','SEARCH','PROFILE'],
    targetLanguages: ['FR','EN'], targetCountries: ['CA'], targetCategories: [], startsAt: '2026-10-01', endsAt: '2026-11-01', reason: 'Campagne validée par la direction'
  }).success).toBe(true));
  it('refuses a campaign write without a reason', () => expect(createCampaignSchema.safeParse({
    name: 'Sans motif', headline: 'Titre', currency: 'XAF', budgetAmount: 10000, pricePerImpression: 2,
    formats: ['NATIVE'], placements: ['HOME_FEED'], startsAt: '2026-10-01', endsAt: '2026-11-01'
  }).success).toBe(false));
  it('requires an idempotent impression event key', () => expect(impressionSchema.safeParse({ eventKey: 'x', format: 'NATIVE', placement: 'HOME_FEED' }).success).toBe(false));
});
