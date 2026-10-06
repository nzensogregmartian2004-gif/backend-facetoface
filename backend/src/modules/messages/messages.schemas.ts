import { z } from 'zod';
import { pageQuerySchema } from '../content/content.schemas';

export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_IMAGE_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MESSAGE_VIDEO_MIME: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

export const openConversationSchema = z.object({ userId: z.string().min(1).max(64) }).strict();

export const sendMessageSchema = z.object({
  text: z.string().trim().max(MESSAGE_MAX_CHARS, `${MESSAGE_MAX_CHARS} caractères maximum`).optional(),
  mediaKey: z.string().min(1).max(300).optional(),
  priceFcfa: z.number().int('Montant entier en FCFA').min(1, 'Montant invalide').optional(),
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Identifiant client invalide').optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.text && !v.mediaKey) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Message vide' });
});

export const mediaUrlSchema = z.object({
  conversationId: z.string().min(1).max(64),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const inboxQuerySchema = pageQuerySchema;
export const messagesQuerySchema = pageQuerySchema;

/** Déblocage d'un message payant : opérateur Mobile Money et numéro à débiter (jamais conservé en entier). */
export const unlockSchema = z.object({
  operator: z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' }),
  phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide'),
}).strict();
