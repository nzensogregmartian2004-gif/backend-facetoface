import { currencySchema } from '../../utils/currency';
import { z } from 'zod';

/** Demande d'appel : aucun paiement. Le client doit avoir des minutes de ce type chez ce créateur (débit à la fin de l'appel). */
export const requestCallSchema = z.object({
  calleeId: z.string().min(1).max(64),
  type: z.enum(['AUDIO', 'VIDEO'], { message: "Type d'appel invalide" }),
}).strict();

export const callSettingsSchema = z.object({
  pricingMode: z.enum(['PER_MINUTE', 'PER_SESSION'], { message: 'Mode de tarification invalide' }).optional(),
  currency: currencySchema.optional(),
  audioPrice: z.number().int('Montant entier (unités mineures)').min(1, 'Montant invalide').nullable().optional(),
  videoPrice: z.number().int('Montant entier (unités mineures)').min(1, 'Montant invalide').nullable().optional(),
  maxDurationMinutes: z.number().int('Nombre entier de minutes').min(1, 'Durée invalide').max(1000, 'Durée invalide').optional(),
  access: z.enum(['EVERYONE', 'FOLLOWERS', 'SUBSCRIBERS'], { message: "Type d'accès invalide" }).optional(),
  isAvailable: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification' });

export const disputeSchema = z.object({
  reason: z.string().trim().min(10, 'Décrivez le problème (10 caractères minimum)').max(1000, '1000 caractères maximum'),
}).strict();
