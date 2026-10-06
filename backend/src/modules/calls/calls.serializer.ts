import type { Call, User } from '@prisma/client';

/**
 * Représentation d'un appel pour `viewer`. Le payeur voit ce qu'il a prépayé, consommé et ce qui lui est dû ; le créateur voit sa part.
 * Les références et réponses brutes du prestataire de paiement ne sortent jamais.
 */
export function serializeCall<O>(c: Call, viewer: User, other: O, now = new Date()) {
  const mine = c.callerId === viewer.id;
  return {
    id: c.id,
    direction: mine ? ('OUTGOING' as const) : ('INCOMING' as const),
    other,
    type: c.type,
    pricingMode: c.pricingMode,
    unitPriceFcfa: c.unitPriceFcfa,
    requestedMinutes: c.requestedMinutes,
    status: c.status,
    endReason: c.endReason,
    payment: mine ? { status: c.paymentStatus, operator: c.operator, review: c.paymentStatus === 'REVIEW' } : null,
    ringExpiresAt: c.ringExpiresAt,
    answeredAt: c.answeredAt,
    endsAt: c.endsAt,
    endedAt: c.endedAt,
    actualSeconds: c.actualSeconds,
    /** Temps restant d'un appel en cours (le mobile s'en sert comme minuteur ; le serveur reste l'autorité). */
    remainingSeconds: c.status === 'ACTIVE' && c.endsAt ? Math.max(0, Math.ceil((c.endsAt.getTime() - now.getTime()) / 1000)) : null,
    money: mine
      ? { prepaidFcfa: c.grossFcfa, consumedFcfa: c.consumedFcfa, refundFcfa: c.refundFcfa, refundStatus: c.refundStatus }
      : { consumedFcfa: c.consumedFcfa, commissionFcfa: c.commissionFcfa, creatorFcfa: c.creatorFcfa, commissionBps: c.commissionBps },
    dispute: c.disputedAt ? { at: c.disputedAt, reason: c.disputeReason } : null,
    createdAt: c.createdAt,
  };
}
export type CallDto = ReturnType<typeof serializeCall>;
