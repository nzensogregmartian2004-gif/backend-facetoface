import { z } from 'zod';

export const POST_MAX_TEXT = 500;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_MAX_OPTION_LENGTH = 80;

export const createPostSchema = z.object({
  text: z.string().trim().min(1, 'Texte requis').max(POST_MAX_TEXT, `${POST_MAX_TEXT} caractères maximum`),
  poll: z
    .array(z.string().trim().min(1, 'Option vide').max(POLL_MAX_OPTION_LENGTH, `${POLL_MAX_OPTION_LENGTH} caractères maximum`))
    .min(POLL_MIN_OPTIONS, 'Au moins deux options')
    .max(POLL_MAX_OPTIONS, 'Quatre options maximum')
    .optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  imageKey: z.string().min(1).max(300).optional(),
}).strict();

/** Vote sur une option du sondage : index de l'option (0 à 3). */
export const voteSchema = z.object({ option: z.number().int().min(0).max(POLL_MAX_OPTIONS - 1) }).strict();

/** Taille maximale d'une image de post (5 Mo). */
export const POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Demande d'envoi d'une image de post : type et taille. */
export const postImageUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(1).max(POST_IMAGE_MAX_BYTES),
}).strict();
