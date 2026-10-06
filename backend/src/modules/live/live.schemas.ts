import { z } from 'zod';

export const createLiveSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  thumbnailKey: z.string().trim().max(500).optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED']).default('PUBLIC'),
  access: z.enum(['EVERYONE', 'SUBSCRIBERS']).default('EVERYONE'),
  scheduledAt: z.coerce.date().optional(),
});

export const updateLiveSchema = createLiveSchema.partial();

export const chatSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export const reactionSchema = z.object({
  type: z.enum(['LIKE', 'LOVE', 'FIRE', 'WOW']),
});

export const liveListSchema = z.object({
  status: z.enum(['SCHEDULED', 'LIVE', 'ENDED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
