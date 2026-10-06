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

// Compatibilité avec les étapes 5/6 historiques qui nomment encore les champs FCFA.
export function splitAmountFcfa(grossFcfa: number, commissionBps: number) {
  const x = splitAmount(grossFcfa, commissionBps);
  return { grossFcfa: x.grossAmount, commissionFcfa: x.platformFeeAmount, creatorFcfa: x.creatorAmount, commissionBps };
}
