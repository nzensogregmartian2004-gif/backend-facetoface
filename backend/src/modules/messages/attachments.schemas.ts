import { z } from 'zod';

/** Demande d'envoi d'une pièce jointe (URL présignée). */
export const uploadAttachmentSchema = z.object({ conversationId: z.string().min(1).max(64), contentType: z.string().trim().toLowerCase().max(150), sizeBytes: z.number().int().min(1), kind: z.enum(['PHOTO','VIDEO','AUDIO','PDF','DOCUMENT','ZIP','VOICE']).optional() }).strict();

/** Déblocage d'une pièce jointe payante : opérateur et numéro (jamais conservé en entier). */
export const unlockAttachmentSchema = z.object({ operator: z.enum(['AIRTEL_MONEY','MOOV_MONEY']), phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/).transform(v => v.replace(/\D/g,'')) }).strict();
