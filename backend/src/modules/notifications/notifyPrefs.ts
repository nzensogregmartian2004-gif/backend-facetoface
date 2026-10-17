import { z } from 'zod';

/** Catégories réglables par l'utilisateur. Les autres types ne sont jamais coupés. */
export const PREF_CATEGORIES = ['messages', 'calls', 'follows', 'gifts', 'lives', 'customVideos'] as const;
export type PrefCategory = (typeof PREF_CATEGORIES)[number];
export type NotifPrefs = Record<PrefCategory, boolean>;

const CATEGORY_OF: Record<string, PrefCategory> = {
  NEW_MESSAGE: 'messages',
  CALL_INCOMING: 'calls', CALL_ACCEPTED: 'calls', CALL_MISSED: 'calls', CALL_ENDED: 'calls',
  CALL_SCHEDULE_REQUESTED: 'calls', CALL_SCHEDULE_ANSWERED: 'calls', CALL_SCHEDULE_CANCELLED: 'calls',
  FOLLOW: 'follows',
  GIFT_RECEIVED: 'gifts', TIP_RECEIVED: 'gifts',
  LIVE_STARTED: 'lives', LIVE_COHOST_INVITE: 'lives',
  CUSTOM_VIDEO_REQUESTED: 'customVideos', CUSTOM_VIDEO_PAYMENT_CONFIRMED: 'customVideos', CUSTOM_VIDEO_DELIVERED: 'customVideos', CUSTOM_VIDEO_COMPLETED: 'customVideos', CUSTOM_VIDEO_DECLINED: 'customVideos',
};

/** Catégorie réglable d'un type de notification, ou null si le type est transactionnel ou de sécurité. */
export function categoryOf(type: string): PrefCategory | null {
  return CATEGORY_OF[type] ?? null;
}

/** Réglages effectifs : une catégorie absente est activée. */
export function prefsFrom(raw: unknown): NotifPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(PREF_CATEGORIES.map((c) => [c, r[c] !== false])) as NotifPrefs;
}

/** Vrai si le destinataire veut ce type de notification. Paiements, retraits, sécurité et modération restent toujours envoyés. */
export function isNotificationEnabled(raw: unknown, type: string): boolean {
  const c = categoryOf(type);
  return c === null ? true : prefsFrom(raw)[c];
}

/** Mise à jour partielle : seules les catégories réglables, en booléen. */
export const prefsPatchSchema = z.object(
  Object.fromEntries(PREF_CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<PrefCategory, z.ZodOptional<z.ZodBoolean>>,
).strict();
