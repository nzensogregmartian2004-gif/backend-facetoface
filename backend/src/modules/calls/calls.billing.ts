import { splitAmount } from '../../utils/money';

/** Ce qui a été figé à la demande d'appel (la règle appliquée ne change plus, même si les réglages du créateur ou la commission changent ensuite). */
export type BillingInput = { pricingMode: 'PER_MINUTE' | 'PER_SESSION'; unitPrice: number; requestedMinutes: number; grossAmount: number; commissionBps: number };
export type Billing = { consumedAmount: number; refundAmount: number; commissionAmount: number; creatorAmount: number; billedMinutes: number };

/** Montant prépayé d'une demande : par minute = prix × minutes ; par session = prix de la session (la durée est alors un plafond). */
export const prepaidAmount = (mode: BillingInput['pricingMode'], unitPrice: number, minutes: number) => (mode === 'PER_MINUTE' ? unitPrice * minutes : unitPrice);

/**
 * Décompte d'un appel terminé, en entiers FCFA (fonction pure, testée).
 *  - durée réelle < `minBillableSeconds` (coupure immédiate, appel jamais établi) : rien n'est consommé, tout est à rembourser ;
 *  - PAR MINUTE : toute minute commencée est due, plafonnée aux minutes prépayées ; le reste est à rembourser ;
 *  - PAR SESSION : la session est due en entier dès qu'elle a réellement commencé.
 * Invariants : gross = consumed + refund ; consumed = commission + créateur.
 */
export function billCall(b: BillingInput, actualSeconds: number, minBillableSeconds: number): Billing {
  const seconds = Math.max(0, Math.floor(actualSeconds));
  let consumedAmount = 0;
  let billedMinutes = 0;
  if (seconds >= minBillableSeconds && seconds > 0) {
    if (b.pricingMode === 'PER_MINUTE') {
      billedMinutes = Math.min(b.requestedMinutes, Math.max(1, Math.ceil(seconds / 60)));
      consumedAmount = Math.min(b.grossAmount, b.unitPrice * billedMinutes);
    } else {
      billedMinutes = b.requestedMinutes;
      consumedAmount = b.grossAmount;
    }
  }
  if (consumedAmount === 0) return { consumedAmount: 0, refundAmount: b.grossAmount, commissionAmount: 0, creatorAmount: 0, billedMinutes: 0 };
  const split = splitAmount(consumedAmount, b.commissionBps);
  return { consumedAmount, refundAmount: b.grossAmount - consumedAmount, commissionAmount: split.platformFeeAmount, creatorAmount: split.creatorAmount, billedMinutes };
}
