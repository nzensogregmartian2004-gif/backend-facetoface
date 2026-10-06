import { z } from 'zod';

export const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Devise ISO 4217 invalide');
export const withdrawalSchema = z.object({
  amount: z.number().int().positive(),
  currency: currencySchema,
  method: z.enum(['MOBILE_MONEY', 'BANK_TRANSFER', 'OTHER']),
  destination: z.string().trim().min(4).max(120),
}).strict();
export const transactionQuerySchema = z.object({ currency: currencySchema.optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
