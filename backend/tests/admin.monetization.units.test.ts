import { describe, expect, it } from 'vitest';
import { settingsPermissionsFor } from '../src/modules/premium/premium.permissions';
import { promotionSchema, settingsSchema, statusSchema } from '../src/modules/premium/premium.schemas';
import { campaignStatusSchema, createCampaignSchema, settingsSchema as adSettingsSchema } from '../src/modules/advertising/advertising.schemas';

describe('permissions Premium, champ par champ', () => {
  it('les prix et la devise relèvent de la finance', () => {
    expect(settingsPermissionsFor({ monthlyPriceMinor: 9000 })).toEqual(['finance.premium.prices.update']);
  });
  it('les autres réglages relèvent de la gestion des abonnements', () => {
    expect(settingsPermissionsFor({ enabled: false })).toEqual(['premium.subscriptions.manage']);
  });
  it('une modification mixte exige les deux permissions', () => {
    expect(settingsPermissionsFor({ annualPriceMinor: 120000, trialDays: 7 })).toEqual(['finance.premium.prices.update', 'premium.subscriptions.manage']);
  });
  it('le motif seul ne demande aucune permission', () => {
    expect(settingsPermissionsFor({ reason: 'Motif suffisant' })).toEqual([]);
  });
  it('ignore les champs absents (undefined)', () => {
    expect(settingsPermissionsFor({ enabled: undefined, monthlyPriceMinor: 9000 })).toEqual(['finance.premium.prices.update']);
  });
});

describe('motif obligatoire sur les écritures d’administration', () => {
  it('un réglage Premium sans motif est refusé', () => {
    expect(settingsSchema.safeParse({ enabled: true }).success).toBe(false);
  });
  it('un motif seul, sans réglage, est refusé', () => {
    expect(settingsSchema.safeParse({ reason: 'Motif suffisant' }).success).toBe(false);
  });
  it('un réglage avec un motif est accepté', () => {
    expect(settingsSchema.safeParse({ enabled: true, reason: 'Relance de l’offre' }).success).toBe(true);
  });
  it('un motif trop court est refusé', () => {
    expect(statusSchema.safeParse({ isActive: false, reason: 'ok' }).success).toBe(false);
  });
  it('une promotion sans motif est refusée', () => {
    expect(promotionSchema.safeParse({ code: 'rentree', type: 'PERCENT', value: 2000, startsAt: '2026-10-01', endsAt: '2026-11-01' }).success).toBe(false);
  });
  it('un réglage publicitaire sans motif est refusé', () => {
    expect(adSettingsSchema.safeParse({ enabled: false }).success).toBe(false);
  });
  it('un changement de statut de campagne avec motif est accepté', () => {
    expect(campaignStatusSchema.safeParse({ status: 'PAUSED', reason: 'Budget à revoir' }).success).toBe(true);
  });
  it('une campagne sans motif est refusée', () => {
    expect(createCampaignSchema.safeParse({
      name: 'Sans motif', headline: 'Titre', currency: 'XAF', budgetAmount: 10000, pricePerImpression: 2,
      formats: ['NATIVE'], placements: ['HOME_FEED'], startsAt: '2026-10-01', endsAt: '2026-11-01',
    }).success).toBe(false);
  });
});
