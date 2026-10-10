import { z } from 'zod';

const operator = z.enum(['AIRTEL_MONEY', 'MOOV_MONEY']);
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform(v => v.replace(/\D/g, '')).refine(v => v.length >= 8 && v.length <= 15, 'Numéro invalide');

/** Motif obligatoire pour toute modification faite par un administrateur (journal d'audit). */
export const reasonSchema = z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300);

export const subscribeSchema = z.object({ billingPeriod: z.enum(['MONTHLY', 'ANNUAL']), operator, phone, promotionCode: z.string().trim().min(2).max(40).optional() }).strict();

export const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyPriceMinor: z.number().int().positive().optional(),
  annualPriceMinor: z.number().int().positive().optional(),
  currency: z.string().trim().length(3).transform(v => v.toUpperCase()).optional(),
  trialEnabled: z.boolean().optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  autoRenewEnabled: z.boolean().optional(),
  benefits: z.record(z.string(), z.unknown()).optional(),
  reason: reasonSchema,
}).strict().refine(x => Object.entries(x).some(([k, v]) => k !== 'reason' && v !== undefined), { message: 'Au moins un réglage est requis', path: ['reason'] });

export const promotionSchema = z.object({
  code: z.string().trim().min(2).max(40).transform(v => v.toUpperCase()),
  type: z.enum(['PERCENT','FIXED']),
  value: z.number().int().positive(),
  currency: z.string().trim().length(3).transform(v => v.toUpperCase()).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  maxRedemptions: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  reason: reasonSchema,
}).strict();

export const statusSchema = z.object({ isActive: z.boolean(), reason: reasonSchema }).strict();
