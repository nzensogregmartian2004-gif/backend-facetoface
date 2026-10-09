import { describe, expect, it } from 'vitest';
import type { Message, User } from '@prisma/client';
import { previewOf, serializeMessage, type ViewOnceOpening } from '../src/modules/messages/messages.serializer';

/** Tests purs (sans base) : la règle « aucun contenu avant ouverture » est vérifiée sur la représentation renvoyée au client. */
const sender = { id: 'u_a', displayName: 'Alice' } as User;
const recipient = { id: 'u_b', displayName: 'Bob' } as User;
const other = { id: 'u_c', displayName: 'Chloé' } as User;
const photo = (over: Partial<Message> = {}): Message => ({
  id: 'm1', conversationId: 'c1', senderId: 'u_a', kind: 'MEDIA', text: null, mediaKey: 'messages/c1/u_a/x.png', mediaMime: 'image/png', mediaSize: 10,
  price: null, currency: null, clientId: null, createdAt: new Date('2026-10-01T10:00:00Z'), deletedAt: null,
  moderationStatus: 'ACTIVE', expiresAt: null, editedAt: null, pinnedAt: null, replyToId: null, forwardedFromId: null,
  viewOnce: true, ...over,
}) as Message;
const text = (over: Partial<Message> = {}): Message => photo({ kind: 'TEXT', mediaKey: null, mediaMime: null, mediaSize: null, text: 'secret', viewOnce: false, ...over });

describe('vocaux : sérialisation', () => {
  it('un vocal ordinaire expose son type AUDIO et sa durée', () => {
    const dto = serializeMessage(photo({ viewOnce: false, mediaMime: 'audio/mp4', mediaDurationMs: 4200 } as Partial<Message>), recipient, false);
    expect(dto.media).toMatchObject({ type: 'AUDIO', durationMs: 4200 });
  });
  it('un vocal à vue unique reste scellé', () => {
    const dto = serializeMessage(photo({ mediaMime: 'audio/mp4', mediaDurationMs: 4200 } as Partial<Message>), recipient, false, null, []);
    expect(dto.media).toBeNull();
    expect(dto.viewOnce).toEqual({ role: 'RECIPIENT', state: 'UNAVAILABLE', openedAt: null });
  });
});

describe('vue unique : sérialisation', () => {
  it('un message ordinaire reste inchangé pour le destinataire (non-régression)', () => {
    const dto = serializeMessage(text(), recipient, false);
    expect(dto.text).toBe('secret');
    expect(dto.kind).toBe('TEXT');
    expect(dto.viewOnce).toBeNull();
  });

  it('une photo à vue unique n’expose ni média, ni type, ni URL, pour l’expéditeur comme pour le destinataire', () => {
    const openings: ViewOnceOpening[] = [{ userId: 'u_b', displayName: 'Bob', openedAt: null }];
    for (const viewer of [recipient, sender]) {
      const dto = serializeMessage(photo(), viewer, false, null, openings);
      expect(dto.media).toBeNull();
      expect(dto.kind).toBeNull();
      expect(dto.text).toBeNull();
      expect(JSON.stringify(dto)).not.toContain('messages/c1');
    }
  });

  it('destinataire : AVAILABLE tant qu’il n’a pas ouvert, OPENED après, UNAVAILABLE s’il n’était pas destinataire', () => {
    const at = new Date('2026-10-01T10:05:00Z');
    const openings: ViewOnceOpening[] = [{ userId: 'u_b', displayName: 'Bob', openedAt: null }, { userId: 'u_c', displayName: 'Chloé', openedAt: at }];
    expect(serializeMessage(photo(), recipient, false, null, openings).viewOnce).toEqual({ role: 'RECIPIENT', state: 'AVAILABLE', openedAt: null });
    const opened = [{ userId: 'u_b', displayName: 'Bob', openedAt: at }];
    expect(serializeMessage(photo(), recipient, false, null, opened).viewOnce).toEqual({ role: 'RECIPIENT', state: 'OPENED', openedAt: at });
    expect(serializeMessage(photo(), other, false, null, opened).viewOnce).toEqual({ role: 'RECIPIENT', state: 'UNAVAILABLE', openedAt: null });
  });

  it('expéditeur : compte des destinataires et qui a ouvert, avec l’heure ; jamais le contenu', () => {
    const at = new Date('2026-10-01T10:05:00Z');
    const openings: ViewOnceOpening[] = [{ userId: 'u_b', displayName: 'Bob', openedAt: at }, { userId: 'u_c', displayName: 'Chloé', openedAt: null }];
    const dto = serializeMessage(photo(), sender, false, null, openings);
    expect(dto.viewOnce).toEqual({ role: 'SENDER', total: 2, openedCount: 1, openings });
    expect(dto.media).toBeNull();
  });

  it('message supprimé : plus d’état de vue unique ni de contenu', () => {
    const dto = serializeMessage(photo({ deletedAt: new Date() }), recipient, false, null, []);
    expect(dto.deleted).toBe(true);
    expect(dto.viewOnce).toBeNull();
    expect(dto.media).toBeNull();
  });
});

describe('vue unique : aperçu de conversation', () => {
  it('affiche un libellé neutre pour les deux participants, jamais le contenu', () => {
    expect(previewOf(photo(), recipient, false)?.text).toBe('👁 Message à vue unique');
    expect(previewOf(photo(), sender, false)?.text).toBe('👁 Message à vue unique');
  });

  it('les aperçus existants (texte, payant verrouillé, photo et vocal ordinaires) ne changent pas', () => {
    expect(previewOf(photo({ viewOnce: false, mediaMime: 'audio/mp4' }), recipient, false)?.text).toBe('🎤 Vocal');
    expect(previewOf(text(), recipient, false)?.text).toBe('secret');
    expect(previewOf(text({ price: 500, currency: 'XAF' }), recipient, false)?.text).toBe('🔒 Message payant');
    expect(previewOf(photo({ viewOnce: false }), recipient, false)?.text).toBe('📷 Photo');
  });
});
