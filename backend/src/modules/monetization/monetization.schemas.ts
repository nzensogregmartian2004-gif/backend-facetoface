import { z } from 'zod';

export const currencyQuerySchema = z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional() }).strict();


export const adRevenueSchema = z.object({
  grossAmount: z.coerce.number().int().nonnegative(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  receivedAt: z.coerce.date().optional(),
  externalReference: z.string().trim().min(1).max(200).optional(),
}).strict();

export const poolPeriodSchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
}).strict().refine((x) => x.end > x.start, { message: 'La fin doit être après le début', path: ['end'] });

export const poolSettingSchema = z.object({
  key: z.literal('CREATOR_POOL_SHARE_BPS'),
  value: z.coerce.number().int().min(0).max(10_000),
  reason: z.string().trim().min(1).max(500),
}).strict();


export const monetizationConditionUpdateSchema = z.object({
  key: z.enum([
    'MIN_SUBSCRIBERS','MIN_WATCH_TIME_SECONDS','WATCH_TIME_PERIOD_DAYS','MIN_SHORT_VIEWS','SHORTS_PERIOD_DAYS',
    'MIN_PUBLICATIONS','PUBLICATIONS_PERIOD_DAYS','REQUIRE_VERIFIED_ACCOUNT','REQUIRE_NO_ACTIVE_SANCTION',
    'REQUIRE_ORIGINAL_CONTENT','EXCLUDE_ARTIFICIAL_VIEWS','EXCLUDE_REMOVED_CONTENT','EXCLUDE_PRIVATE_CONTENT',
    'MIN_PAYOUT_AGE','REQUIRE_MANUAL_VALIDATION','VIDEO_MIN_DURATION_SECONDS','VIDEO_MIN_WATCHED_SECONDS',
    'VIDEO_MIN_WATCH_PERCENT_BPS','SHORT_MIN_DURATION_SECONDS','SHORT_MIN_WATCHED_SECONDS','SHORT_MIN_WATCH_PERCENT_BPS',
    'LIVE_MIN_DURATION_SECONDS','LIVE_MIN_VIEWERS','LIVE_MIN_UNIQUE_VIEWERS','LIVE_MIN_WATCH_TIME_SECONDS',
    'LIVE_MIN_ENGAGEMENT_BPS'
  ]),
  value: z.coerce.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
}).strict();
