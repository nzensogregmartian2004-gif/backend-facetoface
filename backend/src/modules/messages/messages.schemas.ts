import { z } from 'zod';
import { currencySchema } from '../../utils/currency';
import { pageQuerySchema } from '../content/content.schemas';

export const MESSAGE_MAX_CHARS = 2000;
/** Autocollants autorisés : liste fermée, le client ne peut pas envoyer autre chose. */
export const MESSAGE_STICKERS = ['😀', '😂', '😍', '👍', '👏', '🙏', '🎉', '🔥', '😢', '😮', '💜', '👋'] as const;
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
  /** Miniature floutée d'un média payant (jamais le média lui-même). */
  previewKey: z.string().min(1).max(300).optional(),
  price: z.number().int('Montant entier (unités mineures)').min(1, 'Montant invalide').optional(),
  currency: currencySchema.optional(),
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Identifiant client invalide').optional(),
  /** Message à vue unique : ouvert une seule fois par le destinataire (conversations privées uniquement, contrôlé en service). */
  viewOnce: z.boolean().optional(),
  /** Durée du vocal ou de la vidéo, en ms (déclarée par le client). Aucune durée maximale : seule la taille du fichier est limitée. */
  durationMs: z.number().int('Durée invalide').min(1, 'Durée invalide').optional(),
  /** Sondage : une question et 2 à 10 options. Choix unique par défaut. */
  poll: z.object({
    question: z.string().trim().min(1, 'Question vide').max(200),
    options: z.array(z.string().trim().min(1, 'Option vide').max(100)).min(2, 'Deux options minimum').max(10, 'Dix options maximum'),
    allowMultiple: z.boolean().optional(),
  }).strict().optional(),
  /** Événement : titre, date de début (future), lieu facultatif. */
  event: z.object({
    title: z.string().trim().min(1, 'Titre vide').max(120),
    startsAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), 'La date doit être dans le futur'),
    place: z.string().trim().max(160).optional(),
  }).strict().optional(),
  /** Autocollant : un emoji de la liste fermée MESSAGE_STICKERS. Pas de texte ni de média avec lui. */
  sticker: z.enum(MESSAGE_STICKERS).optional(),
  /** Localisation partagée : coordonnées et libellé facultatif. */
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    label: z.string().trim().max(120).optional(),
  }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  const extras = [v.poll, v.event, v.location, v.sticker].filter(Boolean).length;
  if (extras > 1) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Un seul type de message à la fois' });
  if (extras === 1 && (v.mediaKey || v.text || v.price != null || v.viewOnce)) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Sondage, événement ou localisation sans texte ni média' });
  if (extras === 0 && !v.text && !v.mediaKey) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Message vide' });
  if (v.currency && v.price == null) ctx.addIssue({ code: 'custom', path: ['price'], message: 'Prix requis avec une devise' });
});

export const mediaUrlSchema = z.object({
  conversationId: z.string().min(1).max(64),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().min(1, 'Fichier vide'),
}).strict();

export const inboxQuerySchema = pageQuerySchema.extend({
  archived: z.enum(['0', '1']).optional(),
  filter: z.enum(['all', 'unread', 'groups', 'favorites']).optional(),
  q: z.string().trim().max(80).optional(),
});
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

/** Mise en favori d'une conversation, pour le membre qui la demande. */
export const favoriteSchema = z.object({ favorite: z.boolean() }).strict();

/** Médias et liens partagés dans une conversation (menu « Médias et liens »). */
export const sharedQuerySchema = pageQuerySchema.extend({ kind: z.enum(['media', 'links']) });

/** Vote sur un sondage : un identifiant d'option (plusieurs seulement si le sondage l'autorise). */
export const voteSchema = z.object({ optionIds: z.array(z.string().min(1).max(64)).min(1, 'Choisissez une option').max(10) }).strict();
