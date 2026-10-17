import { describe, expect, it } from 'vitest';
import { categoryOf, isNotificationEnabled, prefsFrom, prefsPatchSchema } from '../src/modules/notifications/notifyPrefs';

describe('préférences de notification', () => {
  it('tout est activé par défaut', () => {
    expect(Object.values(prefsFrom(null)).every(Boolean)).toBe(true);
  });
  it('une catégorie coupée bloque ses seuls types', () => {
    expect(isNotificationEnabled({ messages: false }, 'NEW_MESSAGE')).toBe(false);
    expect(isNotificationEnabled({ messages: false }, 'CALL_INCOMING')).toBe(true);
  });
  it('les types transactionnels et de sécurité ne sont jamais coupés', () => {
    const all = { messages: false, calls: false, follows: false, gifts: false, lives: false, customVideos: false };
    expect(categoryOf('PAYMENT_RECEIVED')).toBeNull();
    expect(isNotificationEnabled(all, 'PAYMENT_RECEIVED')).toBe(true);
    expect(isNotificationEnabled(all, 'MODERATION')).toBe(true);
    expect(isNotificationEnabled(all, 'WITHDRAWAL')).toBe(true);
  });
  it('la mise à jour n’accepte que les catégories connues, en booléen', () => {
    expect(prefsPatchSchema.safeParse({ messages: false }).success).toBe(true);
    expect(prefsPatchSchema.safeParse({ messages: 'non' }).success).toBe(false);
    expect(prefsPatchSchema.safeParse({ inconnu: true }).success).toBe(false);
  });
});
