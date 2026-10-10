/** Délais des litiges et de la purge du contenu retiré. Fonctions pures, sans base. */
export const DISPUTE_RESPONSE_DAYS_DEFAULT = 3;
export const CONTENT_PURGE_DAYS_DEFAULT = 30;
const DAY_MS = 86_400_000;

export type DisputeState = { disputedAt: Date | null; disputeClosedAt: Date | null; disputeRespondedAt: Date | null };

/** Date limite de réponse : ouverture du litige plus le délai. */
export function disputeDeadline(disputedAt: Date, days: number): Date {
  return new Date(disputedAt.getTime() + days * DAY_MS);
}

/** Le créateur peut répondre : litige ouvert, pas encore de réponse, délai non dépassé. */
export function canRespondToDispute(d: DisputeState, now: Date, days: number): boolean {
  if (!d.disputedAt || d.disputeClosedAt || d.disputeRespondedAt) return false;
  return now.getTime() <= disputeDeadline(d.disputedAt, days).getTime();
}

/** Clôture automatique sans montant : litige sans réponse dont le délai est dépassé. */
export function isDisputeAutoClosable(d: DisputeState, now: Date, days: number): boolean {
  if (!d.disputedAt || d.disputeClosedAt || d.disputeRespondedAt) return false;
  return now.getTime() > disputeDeadline(d.disputedAt, days).getTime();
}

/** La purge d'un contenu retiré n'est possible qu'après le délai de conservation. */
export function canPurgeContent(removedAt: Date | null, now: Date, days: number): boolean {
  return !!removedAt && now.getTime() >= removedAt.getTime() + days * DAY_MS;
}
