import { z } from 'zod';

/** Durées vendues par un créateur : bornes communes à tous. */
export const OFFER_MIN_SECONDS = 10;
export const OFFER_MAX_SECONDS = 3600;
export const OFFERS_MAX_PER_KIND = 10;

const kind = z.enum(['AUDIO', 'VIDEO'], { message: 'Type d’appel invalide' });
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide')
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide');

/** Le créateur remplace la liste des durées vendues pour un type d'appel. */
export const offersSchema = z.object({
  kind,
  offers: z.array(z.object({
    seconds: z.number().int().min(OFFER_MIN_SECONDS).max(OFFER_MAX_SECONDS),
  }).strict()).min(1).max(OFFERS_MAX_PER_KIND),
}).strict();

/** Achat : une durée précise chez un créateur précis. */
export const buyMinutesSchema = z.object({
  creatorId: z.string().min(1).max(64),
  offerId: z.string().min(1).max(64),
  operator: z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' }),
  phone,
}).strict();
