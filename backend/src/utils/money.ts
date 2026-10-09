import { badRequest } from './errors';
export const DEFAULT_COMMISSION_BPS = 2000;

/** Split exact en unités mineures : plateforme + créateur = brut. */
export function splitAmount(grossAmount: number, commissionBps: number) {
  if (!Number.isSafeInteger(grossAmount) || grossAmount <= 0) throw badRequest('INVALID_AMOUNT', 'Montant invalide');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) throw badRequest('INVALID_COMMISSION', 'Commission invalide');
  const platformFeeAmount = Math.round((grossAmount * commissionBps) / 10_000);
  const creatorAmount = grossAmount - platformFeeAmount;
  return { grossAmount, platformFeeAmount, creatorAmount, commissionBps };
}

/** Même split, mais avec les noms de colonnes des tables de paiement (`commissionAmount`) et la devise : prêt à être écrit en base. */
export function splitRecord(grossAmount: number, commissionBps: number, currency: string) {
  const x = splitAmount(grossAmount, commissionBps);
  return { grossAmount: x.grossAmount, commissionAmount: x.platformFeeAmount, creatorAmount: x.creatorAmount, commissionBps, currency };
}
