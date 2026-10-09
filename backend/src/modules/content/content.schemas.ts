import { z } from 'zod';
import { CATEGORY_SLUGS } from './categories';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const titleSchema = z.string().trim().min(1, 'Titre obligatoire').max(100, '100 caractères maximum');
export const descriptionSchema = z.preprocess(emptyToNull, z.string().trim().max(2000, '2000 caractères maximum').nullable());
export const categorySchema = z.enum(CATEGORY_SLUGS, { message: 'Catégorie inconnue' });
export const visibilitySchema = z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']);
export const priceSchema = z.number().int().positive('Le prix doit être supérieur à zéro');
export const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Devise ISO 4217 invalide');

const paidFields = {
  price: priceSchema.optional().nullable(),
  currency: currencySchema.optional().nullable(),
};

const validatePaidFields = (data: { price?: number | null; currency?: string | null }, ctx: z.RefinementCtx) => {
  if ((data.price == null) !== (data.currency == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'Prix et devise doivent être fournis ensemble' });
  }
};

export const createContentSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  category: categorySchema,
  visibility: visibilitySchema.optional(),
  allowDownload: z.boolean().optional(),
  subscriptionOnly: z.boolean().optional(),
  allowComments: z.boolean().optional(),
  ...paidFields,
}).strict().superRefine(validatePaidFields);

export const updateContentSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  category: categorySchema.optional(),
  visibility: visibilitySchema.optional(),
  allowDownload: z.boolean().optional(),
  subscriptionOnly: z.boolean().optional(),
  allowComments: z.boolean().optional(),
  ...paidFields,
}).strict().superRefine(validatePaidFields);

export const uploadUrlSchema = z.object({
  file: z.enum(['video', 'thumbnail']),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const completeUploadSchema = z.object({
  durationSeconds: z.number().int().min(1, 'Durée invalide').max(24 * 3600),
  width: z.number().int().min(1).max(10_000).optional(),
  height: z.number().int().min(1).max(10_000).optional(),
  /** Étape 13 : découpage et image de couverture (en millisecondes, dans la source). */
  edit: z.object({
    startMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    endMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    coverMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
  }).strict().optional(),
}).strict();

export const viewSchema = z.object({ watchedSeconds: z.number().int().min(0).max(24 * 3600).optional() }).strict();
/** Un commentaire est soit du texte (500 caractères max), soit un vocal déjà envoyé (audioKey) : jamais les deux, jamais aucun des deux. */
export const commentSchema = z.object({
  text: z.string().trim().min(1, 'Commentaire vide').max(500, '500 caractères maximum').optional(),
  audioKey: z.string().min(1).max(300).optional(),
  durationMs: z.number().int().min(1, 'Durée invalide').optional(),
}).strict().refine((v) => Number(v.text !== undefined) + Number(v.audioKey !== undefined) === 1, { message: 'Un commentaire est soit du texte, soit un vocal' });
export const commentAudioUrlSchema = z.object({
  targetType: z.enum(['VIDEO', 'SHORT']),
  targetId: z.string().min(1).max(64),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const pageQuerySchema = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const mineQuerySchema = pageQuerySchema.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'HIDDEN']).optional() });
export const feedQuerySchema = pageQuerySchema.extend({ type: z.enum(['video', 'short']).default('video') });

/** Temps de visionnage d'un Short envoyé par lots (étape 11). Une session = une lecture d'un Short à l'écran. */
export const watchBatchSchema = z.object({
  sessions: z.array(z.object({
    clientSessionId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    watchedMs: z.number().int().min(0).max(300_000),
    completed: z.boolean(),
  }).strict()).min(1).max(50),
}).strict();
export const retentionQuerySchema = z.object({ range: z.enum(['7d', '30d', '90d']).default('30d') }).strict();
/** Envoi par parties (étape 10, lot 3). */
export const multipartStartSchema = z.object({ sizeBytes: z.number().int().min(1).max(2_147_483_647), contentType: z.string().max(100) }).strict();
export const multipartPartSchema = z.object({ partNumber: z.number().int().min(1).max(10_000) }).strict();
