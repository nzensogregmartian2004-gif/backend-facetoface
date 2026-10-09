import { z } from 'zod';
import { currencySchema } from '../../utils/currency';
import { pageQuerySchema } from '../content/content.schemas';

export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_IMAGE_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MESSAGE_VIDEO_MIME: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
/** Vocaux : M4A/AAC (enregistrement natif iOS et Android), MP3. */
export const MESSAGE_AUDIO_MIME: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3' };
export type MediaType = 'IMAGE' | 'VIDEO' | 'AUDIO';
export const mediaTypeOf = (mime: string | null): MediaType => (mime && MESSAGE_IMAGE_MIME[mime] ? 'IMAGE' : mime && MESSAGE_AUDIO_MIME[mime] ? 'AUDIO' : 'VIDEO');

export const openConversationSchema = z.object({ userId: z.string().min(1).max(64) }).strict();

export const sendMessageSchema = z.object({
  text: z.string().trim().max(MESSAGE_MAX_CHARS, `${MESSAGE_MAX_CHARS} caractères maximum`).optional(),
  mediaKey: z.string().min(1).max(300).optional(),
  price: z.number().int('Montant entier (unités mineures)').min(1, 'Montant invalide').optional(),
  currency: currencySchema.optional(),
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Identifiant client invalide').optional(),
  /** Message à vue unique : ouvert une seule fois par le destinataire (conversations privées uniquement, contrôlé en service). */
  viewOnce: z.boolean().optional(),
  /** Durée du vocal ou de la vidéo, en ms (déclarée par le client). Aucune durée maximale : seule la taille du fichier est limitée. */
  durationMs: z.number().int('Durée invalide').min(1, 'Durée invalide').optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.text && !v.mediaKey) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Message vide' });
  if (v.currency && v.price == null) ctx.addIssue({ code: 'custom', path: ['price'], message: 'Prix requis avec une devise' });
});

export const mediaUrlSchema = z.object({
  conversationId: z.string().min(1).max(64),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const inboxQuerySchema = pageQuerySchema.extend({ archived: z.enum(['0', '1']).optional() });
export const messagesQuerySchema = pageQuerySchema;

/** Déblocage d'un message payant : opérateur Mobile Money et numéro à débiter (jamais conservé en entier). */
export const unlockSchema = z.object({
  operator: z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' }),
  phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide'),
}).strict();

export const messageActionSchema = z.object({ messageId: z.string().min(1).max(64) }).strict();
export const reactionSchema = z.object({ emoji: z.string().trim().min(1).max(8) }).strict();
export const editMessageSchema = z.object({ text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS) }).strict();
export const searchMessagesSchema = pageQuerySchema.extend({ q: z.string().trim().min(1).max(100) }).strict();
/** Messages éphémères : 0 (désactivé) ou un nombre entier de jours, de 1 à 365. */
export const DISAPPEARING_MAX_SECONDS = 365 * 86_400;
export const isValidDisappearingSeconds = (v: number) => v === 0 || (Number.isInteger(v) && v >= 86_400 && v <= DISAPPEARING_MAX_SECONDS && v % 86_400 === 0);
export const disappearingSchema = z.object({ seconds: z.number().int().refine(isValidDisappearingSeconds, { message: 'Durée invalide : désactivé, ou de 1 à 365 jours entiers' }) }).strict();
export const muteSchema = z.object({ seconds: z.number().int().min(0).max(31536000) }).strict();
export const starSchema = z.object({ starred: z.boolean() }).strict();
export const archiveSchema = z.object({ archived: z.boolean() }).strict();
