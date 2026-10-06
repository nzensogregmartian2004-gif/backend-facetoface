import { splitAmountFcfa } from '../../utils/money';

/** Ce qui a été figé à la demande d'appel (la règle appliquée ne change plus, même si les réglages du créateur ou la commission changent ensuite). */
export type BillingInput = { pricingMode: 'PER_MINUTE' | 'PER_SESSION'; unitPriceFcfa: number; requestedMinutes: number; grossFcfa: number; commissionBps: number };
export type Billing = { consumedFcfa: number; refundFcfa: number; commissionFcfa: number; creatorFcfa: number; billedMinutes: number };

/** Montant prépayé d'une demande : par minute = prix × minutes ; par session = prix de la session (la durée est alors un plafond). */
export const prepaidAmount = (mode: BillingInput['pricingMode'], unitPriceFcfa: number, minutes: number) => (mode === 'PER_MINUTE' ? unitPriceFcfa * minutes : unitPriceFcfa);

/**
 * Décompte d'un appel terminé, en entiers FCFA (fonction pure, testée).
 *  - durée réelle < `minBillableSeconds` (coupure immédiate, appel jamais établi) : rien n'est consommé, tout est à rembourser ;
 *  - PAR MINUTE : toute minute commencée est due, plafonnée aux minutes prépayées ; le reste est à rembourser ;
 *  - PAR SESSION : la session est due en entier dès qu'elle a réellement commencé.
 * Invariants : gross = consumed + refund ; consumed = commission + créateur.
 */
export function billCall(b: BillingInput, actualSeconds: number, minBillableSeconds: number): Billing {
  const seconds = Math.max(0, Math.floor(actualSeconds));
  let consumedFcfa = 0;
  let billedMinutes = 0;
  if (seconds >= minBillableSeconds && seconds > 0) {
    if (b.pricingMode === 'PER_MINUTE') {
      billedMinutes = Math.min(b.requestedMinutes, Math.max(1, Math.ceil(seconds / 60)));
      consumedFcfa = Math.min(b.grossFcfa, b.unitPriceFcfa * billedMinutes);
    } else {
      billedMinutes = b.requestedMinutes;
      consumedFcfa = b.grossFcfa;
    }
  }
  if (consumedFcfa === 0) return { consumedFcfa: 0, refundFcfa: b.grossFcfa, commissionFcfa: 0, creatorFcfa: 0, billedMinutes: 0 };
  const split = splitAmountFcfa(consumedFcfa, b.commissionBps);
  return { consumedFcfa, refundFcfa: b.grossFcfa - consumedFcfa, commissionFcfa: split.commissionFcfa, creatorFcfa: split.creatorFcfa, billedMinutes };
}
