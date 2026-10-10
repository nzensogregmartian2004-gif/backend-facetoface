import { describe, expect, it } from 'vitest';
import { disputeDecisionSchema } from '../src/modules/admin/disputes.schemas';

describe('litiges : aucun remboursement', () => {
  it('un montant de remboursement positif est refusé', () => {
    expect(disputeDecisionSchema.safeParse({ type: 'CALL', refundAmount: 500, reason: 'Motif suffisant' }).success).toBe(false);
  });
  it('la clôture sans montant (0) est acceptée, et vaut 0 par défaut', () => {
    expect(disputeDecisionSchema.parse({ type: 'CALL', reason: 'Motif suffisant' }).refundAmount).toBe(0);
    expect(disputeDecisionSchema.safeParse({ type: 'CUSTOM_VIDEO', refundAmount: 0, reason: 'Motif suffisant' }).success).toBe(true);
  });
});
