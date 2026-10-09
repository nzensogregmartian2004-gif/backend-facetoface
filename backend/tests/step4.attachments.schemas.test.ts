import { describe, expect, it } from 'vitest';
import { sendMessageSchema } from '../src/modules/messages/messages.schemas';
import { uploadAttachmentSchema, unlockAttachmentSchema } from '../src/modules/messages/attachments.schemas';

const upload = { conversationId: 'conv_1', contentType: 'application/pdf', sizeBytes: 2048, kind: 'PDF' };

describe('step 4 pièces jointes (schémas réels)', () => {
  it('accepte une demande d\'envoi PDF gratuite', () => {
    expect(uploadAttachmentSchema.safeParse(upload).success).toBe(true);
  });
  it('refuse un fichier vide', () => {
    expect(uploadAttachmentSchema.safeParse({ ...upload, sizeBytes: 0 }).success).toBe(false);
  });
  it('déblocage : opérateur Mobile Money obligatoire', () => {
    expect(unlockAttachmentSchema.safeParse({ operator: 'AIRTEL_MONEY', phone: '077 12 34 56' }).success).toBe(true);
    expect(unlockAttachmentSchema.safeParse({ operator: 'VISA', phone: '077123456' }).success).toBe(false);
  });
  it('message : une devise sans montant est refusée', () => {
    expect(sendMessageSchema.safeParse({ text: 'bonjour', currency: 'USD' }).success).toBe(false);
  });
});
