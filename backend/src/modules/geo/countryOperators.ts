/**
 * Opérateurs disponibles par pays (codes MyPVit : AIRTEL_MONEY, MOOV_MONEY, VISA, MASTERCARD).
 * Un pays absent de cette table garde les opérateurs configurés sur le serveur. À compléter pays par pays.
 */
export const OPERATORS_BY_COUNTRY: Record<string, string[]> = {
  GA: ['AIRTEL_MONEY', 'MOOV_MONEY', 'VISA', 'MASTERCARD'],
};
