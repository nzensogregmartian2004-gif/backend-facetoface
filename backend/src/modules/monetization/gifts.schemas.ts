import { z } from 'zod';
export const paymentMethodSchema = z.object({
  method: z.enum(['AIRTEL_MONEY','MOOV_MONEY']),
  phone: z.string().trim().min(6).max(30),
}).strict();
export const giftSendSchema = paymentMethodSchema.extend({
  creatorId: z.string().cuid(),
  giftId: z.string().cuid(),
  liveId: z.string().cuid().optional(),
}).strict();
export const tipSchema = paymentMethodSchema.extend({
  creatorId: z.string().cuid(),
  amount: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  liveId: z.string().cuid().optional(),
  message: z.string().trim().max(160).optional(),
}).strict();
export const giftAdminSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  emoji: z.string().trim().min(1).max(8),
  imageKey: z.string().trim().max(500).nullable().optional(),
  animationKey: z.string().trim().max(500).nullable().optional(),
  rarity: z.string().trim().max(40).nullable().optional(),
  price: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).strict();
