import { z } from 'zod';
import { currencySchema } from '../../utils/currency';

const operator = z.enum(['AIRTEL_MONEY', 'MOOV_MONEY']);
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide');

export const requestSchema = z.object({
  requestText: z.string().trim().min(3).max(2_000),
}).strict();

export const offerSchema = z.object({
  price: z.number().int().min(1),
  currency: currencySchema.optional(),
  deadlineDays: z.number().int().min(1).max(30),
}).strict();

export const paySchema = z.object({ operator, phone }).strict();
export const disputeSchema = z.object({ reason: z.string().trim().min(3).max(1_000) }).strict();
export const uploadSchema = z.object({ file: z.literal('video'), contentType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']), sizeBytes: z.number().int().positive() }).strict();
export const completeUploadSchema = z.object({ durationSeconds: z.number().int().positive().max(900) }).strict();
