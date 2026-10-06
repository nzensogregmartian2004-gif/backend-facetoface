import { z } from 'zod';

export const configTypeSchema = z.enum(['STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'JSON']);
export const configCategorySchema = z.enum([
  'PREMIUM',
  'COMMISSION',
  'CREATOR_POOL',
  'MONETIZATION',
  'SHORTS',
  'VIDEOS',
  'LIVES',
  'WITHDRAWALS',
  'FEATURE_PRICING',
  'ADVERTISING',
  'PROMOTIONS',
  'GENERAL',
]);

export const upsertConfigSchema = z.object({
  key: z.string().trim().min(2).max(120).regex(/^[A-Z0-9_.-]+$/),
  value: z.unknown(),
  type: configTypeSchema,
  enabled: z.boolean().default(true),
  description: z.string().trim().min(1).max(1000),
  defaultValue: z.unknown(),
  category: configCategorySchema,
  reason: z.string().trim().min(1).max(500),
});

export const updateConfigSchema = z.object({
  value: z.unknown(),
  enabled: z.boolean().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  reason: z.string().trim().min(1).max(500),
});

export const listConfigSchema = z.object({
  category: configCategorySchema.optional(),
  enabled: z.coerce.boolean().optional(),
  q: z.string().trim().max(120).optional(),
});


export const configVersionListSchema = z.object({
  key: z.string().trim().max(120).optional(),
  version: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const restoreDefaultsSchema = z.object({ confirm: z.literal(true) }).strict();
