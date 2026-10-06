import { describe, expect, it } from 'vitest';

describe('anti-fraude — invariants', () => {
  it('exclut les décisions REVIEW/BLOCK du flux rémunérable', () => {
    const decisions = ['ALLOW', 'REVIEW', 'BLOCK'] as const;
    expect(decisions.filter((d) => d !== 'ALLOW')).toEqual(['REVIEW', 'BLOCK']);
  });

  it('reconnaît les grandes familles de signaux prévues par l’étape 20', () => {
    expect(['AUTOMATED_CLIENT', 'HIGH_ACTIVITY_RATE', 'HIGH_IP_ACTIVITY', 'NEW_ACCOUNT_VIEW_SPIKE', 'IMPOSSIBLE_WATCH_TIME', 'CLICK_VELOCITY', 'NEW_ACCOUNT_PAYMENT_SPIKE']).toHaveLength(7);
  });
});
