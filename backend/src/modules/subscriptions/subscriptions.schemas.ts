import { z } from 'zod';
import { currencySchema } from '../../utils/currency';

const operator = z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' });
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide');

export const planSchema = z.object({
  price: z.number().int().min(1),
  currency: currencySchema.optional(),
  benefits: z.object({
    exclusiveContent: z.boolean().default(false),
    privateLives: z.boolean().default(false),
    directMessages: z.boolean().default(false),
    subscriberCalls: z.boolean().default(false),
    includedCallMinutes: z.number().int().min(0).max(10000).default(0),
    downloads: z.boolean().default(false),
    other: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  }).strict(),
  isActive: z.boolean().optional(),
}).strict();

export const subscribeSchema = z.object({ operator, phone }).strict();
