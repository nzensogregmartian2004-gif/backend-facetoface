import { describe, expect, it } from 'vitest';
import { buyCoinsSchema } from '../src/modules/coins/coins.schemas';

describe('étape 8 — opérateurs d’achat de coins', () => {
  it('accepte Airtel, Moov et les cartes (activées côté serveur par payments.operators())', () => {
    for (const operator of ['AIRTEL_MONEY', 'MOOV_MONEY', 'VISA', 'MASTERCARD']) {
      expect(buyCoinsSchema.shape.operator.safeParse(operator).success).toBe(true);
    }
  });
  it('refuse tout autre opérateur', () => {
    for (const operator of ['PAYPAL', '', 'airtel_money']) {
      expect(buyCoinsSchema.shape.operator.safeParse(operator).success).toBe(false);
    }
  });
});
