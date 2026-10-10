import { z } from 'zod';
import { MAX_MESSAGE_LENGTH, SUPPORT_CATEGORIES, SUPPORT_STATUSES } from './support.rules';

const categorySchema = z.enum(SUPPORT_CATEGORIES);
const statusSchema = z.enum(SUPPORT_STATUSES);
const bodySchema = z.string().trim().min(1, 'Message vide').max(MAX_MESSAGE_LENGTH, `Message trop long (${MAX_MESSAGE_LENGTH} caractères maximum)`);

export const createTicketSchema = z.object({
  subject: z.string().trim().min(3, 'Objet trop court').max(160, 'Objet trop long (160 caractères maximum)'),
  category: categorySchema.default('OTHER'),
  body: bodySchema,
}).strict();

export const replySchema = z.object({ body: bodySchema }).strict();

/** Motif obligatoire pour tout changement de statut fait par l'équipe (journal d'audit). */
export const ticketStatusChangeSchema = z.object({
  status: statusSchema,
  reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300),
}).strict();

export const adminTicketQuerySchema = z.object({
  status: statusSchema.optional(),
  category: categorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
