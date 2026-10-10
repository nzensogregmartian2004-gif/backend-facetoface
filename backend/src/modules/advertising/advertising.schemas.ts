import { z } from 'zod';

export const adFormatSchema = z.enum(['PRE_ROLL','MID_ROLL','SHORT_BETWEEN','NATIVE','BANNER','INTERSTITIAL','LIVE']);
export const adPlacementSchema = z.enum(['HOME_FEED','VIDEO_PLAYER','SHORT_FEED','LIVE_PLAYER','SEARCH','PROFILE']);

/** Motif obligatoire pour toute modification faite par un administrateur (journal d'audit). */
export const reasonSchema = z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300);

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  headline: z.string().trim().min(1).max(160),
  body: z.string().trim().max(500).optional(),
  mediaUrl: z.string().url().max(2000).optional(),
  clickUrl: z.string().url().max(2000).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  budgetAmount: z.coerce.number().int().positive(),
  pricePerImpression: z.coerce.number().int().positive(),
  formats: z.array(adFormatSchema).min(1).max(7),
  placements: z.array(adPlacementSchema).min(1).max(6),
  targetLanguages: z.array(z.enum(['FR','EN'])).max(2).default([]),
  targetCountries: z.array(z.string().trim().min(2).max(2).transform(v => v.toUpperCase())).max(100).default([]),
  targetCategories: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  frequencyCap: z.coerce.number().int().min(1).max(100).optional(),
  frequencyWindowHours: z.coerce.number().int().min(1).max(720).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  reason: reasonSchema,
}).strict().refine(x => x.endsAt > x.startsAt, { message: 'La fin doit être après le début', path: ['endsAt'] });

export const campaignStatusSchema = z.object({ status: z.enum(['DRAFT','ACTIVE','PAUSED','COMPLETED','ARCHIVED']), reason: reasonSchema }).strict();

export const adQuerySchema = z.object({
  format: adFormatSchema,
  placement: adPlacementSchema,
  category: z.string().trim().max(80).optional(),
  contentType: z.enum(['VIDEO','SHORT','LIVE']).optional(),
  contentId: z.string().trim().max(100).optional(),
  creatorId: z.string().trim().max(100).optional(),
}).strict();

export const impressionSchema = z.object({
  campaignId: z.string().trim().min(1).max(100),
  eventKey: z.string().trim().min(8).max(160),
  format: adFormatSchema,
  placement: adPlacementSchema,
  contentType: z.enum(['VIDEO','SHORT','LIVE']).optional(),
  contentId: z.string().trim().max(100).optional(),
  creatorId: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
}).strict();

export const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  defaultFrequencyCap: z.coerce.number().int().min(1).max(100).optional(),
  defaultFrequencyWindowHours: z.coerce.number().int().min(1).max(720).optional(),
  creatorShareBps: z.coerce.number().int().min(0).max(10_000).optional(),
  reason: reasonSchema,
}).strict().refine(x => Object.entries(x).some(([k, v]) => k !== 'reason' && v !== undefined), { message: 'Au moins un paramètre est requis', path: ['reason'] });
