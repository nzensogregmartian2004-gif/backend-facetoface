import { z } from 'zod';
import { CATEGORY_SLUGS } from './categories';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const titleSchema = z.string().trim().min(1, 'Titre obligatoire').max(100, '100 caractères maximum');
export const descriptionSchema = z.preprocess(emptyToNull, z.string().trim().max(2000, '2000 caractères maximum').nullable());
export const categorySchema = z.enum(CATEGORY_SLUGS, { message: 'Catégorie inconnue' });
export const visibilitySchema = z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']);

export const createContentSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  category: categorySchema,
  visibility: visibilitySchema.optional(),
  allowDownload: z.boolean().optional(),
  subscriptionOnly: z.boolean().optional(),
  allowComments: z.boolean().optional(),
}).strict();

export const updateContentSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  category: categorySchema.optional(),
  visibility: visibilitySchema.optional(),
  allowDownload: z.boolean().optional(),
  subscriptionOnly: z.boolean().optional(),
  allowComments: z.boolean().optional(),
}).strict();

export const uploadUrlSchema = z.object({
  file: z.enum(['video', 'thumbnail']),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const completeUploadSchema = z.object({
  durationSeconds: z.number().int().min(1, 'Durée invalide').max(24 * 3600),
  width: z.number().int().min(1).max(10_000).optional(),
  height: z.number().int().min(1).max(10_000).optional(),
}).strict();

export const viewSchema = z.object({ watchedSeconds: z.number().int().min(0).max(24 * 3600).optional() }).strict();
export const commentSchema = z.object({ text: z.string().trim().min(1, 'Commentaire vide').max(500, '500 caractères maximum') }).strict();

export const pageQuerySchema = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const mineQuerySchema = pageQuerySchema.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'HIDDEN']).optional() });
export const feedQuerySchema = pageQuerySchema.extend({ type: z.enum(['video', 'short']).default('video') });
