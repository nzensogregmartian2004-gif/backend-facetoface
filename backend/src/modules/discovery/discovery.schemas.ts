import { z } from 'zod';
import { feedQuerySchema, pageQuerySchema } from '../content/content.schemas';
import { countrySchema } from '../../utils/schemas';
import { normalizeTag } from './tags';

/** `q` optionnel : « #Gabon », « gab » ou vide (vide = tendances). */
export const hashtagQuerySchema = z.object({
  q: z.string().trim().max(40).transform((v) => normalizeTag(v.replace(/^#+/, ''))).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(10),
}).strict();

export const hashtagContentsQuerySchema = pageQuerySchema.extend({
  type: z.enum(['video', 'short']).default('video'),
});

export const localFeedQuerySchema = feedQuerySchema.extend({ country: countrySchema.optional() });

export const popularQuerySchema = z.object({
  country: countrySchema.optional(),
  limit: z.coerce.number().int().min(1).max(30).default(10),
}).strict();
