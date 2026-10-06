import { z } from 'zod';

const operator = z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' });
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide');

/** Demande d'appel : le montant est calculé par le serveur d'après les réglages du créateur (le client n'envoie jamais de prix). */
export const requestCallSchema = z.object({
  calleeId: z.string().min(1).max(64),
  type: z.enum(['AUDIO', 'VIDEO'], { message: "Type d'appel invalide" }),
  /** Minutes à prépayer (tarif par minute). Ignoré pour un tarif par session. */
  minutes: z.number().int('Nombre entier de minutes').min(1, 'Durée invalide').max(1000, 'Durée invalide').optional(),
  operator,
  phone,
}).strict();

export const callSettingsSchema = z.object({
  pricingMode: z.enum(['PER_MINUTE', 'PER_SESSION'], { message: 'Mode de tarification invalide' }).optional(),
  audioPriceFcfa: z.number().int('Montant entier en FCFA').min(1, 'Montant invalide').nullable().optional(),
  videoPriceFcfa: z.number().int('Montant entier en FCFA').min(1, 'Montant invalide').nullable().optional(),
  maxDurationMinutes: z.number().int('Nombre entier de minutes').min(1, 'Durée invalide').max(1000, 'Durée invalide').optional(),
  access: z.enum(['EVERYONE', 'FOLLOWERS', 'SUBSCRIBERS'], { message: "Type d'accès invalide" }).optional(),
  isAvailable: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification' });

export const disputeSchema = z.object({
  reason: z.string().trim().min(10, 'Décrivez le problème (10 caractères minimum)').max(1000, '1000 caractères maximum'),
}).strict();
