import { z } from 'zod';

/** Réglages d'un groupe. `entryPrice` : prix d'entrée en FCFA (entier) ; null = groupe gratuit. Les bornes sont vérifiées par le service. */
export const groupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  allowPaidContent: z.boolean().optional(),
  entryPrice: z.number().int('Prix entier (FCFA)').nullable().optional(),
}).strict();

/** Passation de la propriété : destinataire et confirmation explicite obligatoire (le propriétaire doit le dire). */
export const transferOwnershipSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  confirm: z.literal(true, { message: 'Confirmez la passation de la propriété' }),
}).strict();
