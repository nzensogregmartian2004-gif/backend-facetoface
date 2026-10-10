import type { AdminPermission } from '../admin/permissions';

/** Champs liés à la finance : prix et devise. Les autres réglages Premium relèvent de la gestion des abonnements. */
const PRICE_FIELDS = new Set(['monthlyPriceMinor', 'annualPriceMinor', 'currency']);

/** Permissions exigées pour modifier un ensemble de réglages Premium. */
export function settingsPermissionsFor(changes: Record<string, unknown>): AdminPermission[] {
  const keys = Object.keys(changes).filter((k) => k !== 'reason' && changes[k] !== undefined);
  const needed: AdminPermission[] = [];
  if (keys.some((k) => PRICE_FIELDS.has(k))) needed.push('finance.premium.prices.update');
  if (keys.some((k) => !PRICE_FIELDS.has(k))) needed.push('premium.subscriptions.manage');
  return needed;
}
