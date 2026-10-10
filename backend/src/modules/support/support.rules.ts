import type { SupportTicketStatus } from '@prisma/client';

/** Règles pures de l'assistance : statuts, transitions et limites. Aucune dépendance à la base. */

export const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED'] as const satisfies readonly SupportTicketStatus[];
export const SUPPORT_CATEGORIES = ['ACCOUNT', 'PAYMENT', 'CONTENT', 'CREATOR', 'MONETIZATION', 'TECHNICAL', 'OTHER'] as const;

/** Statuts d'un ticket encore en cours : ils comptent dans la limite d'ouverture. */
export const OPEN_STATUSES: readonly SupportTicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_USER'];

/** Nombre maximal de tickets en cours par utilisateur (anti-abus). */
export const MAX_OPEN_TICKETS_PER_USER = 5;
export const MAX_MESSAGE_LENGTH = 2000;

/** Un utilisateur peut répondre tant que le ticket n'est pas clos. */
export const canUserReply = (status: SupportTicketStatus) => status !== 'CLOSED';

/** Après une réponse de l'utilisateur, le ticket redevient à traiter, sauf s'il est déjà en cours de traitement. */
export const statusAfterUserReply = (status: SupportTicketStatus): SupportTicketStatus =>
  status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OPEN';

/** Après une réponse de l'équipe, le ticket attend la réponse de l'utilisateur. */
export const statusAfterAdminReply = (): SupportTicketStatus => 'WAITING_USER';

/** Une réponse de l'équipe n'est possible que si le ticket n'est pas clos ; il faut le rouvrir avant. */
export const canAdminReply = (status: SupportTicketStatus) => status !== 'CLOSED';

/** Un changement de statut doit réellement changer le statut. */
export const isStatusChange = (from: SupportTicketStatus, to: SupportTicketStatus) => from !== to;

/**
 * Date de résolution : posée au passage à « résolu » ou « clos », retirée à la réouverture,
 * conservée sinon (par exemple « résolu » vers « clos »).
 */
export function resolvedAtAfter(from: SupportTicketStatus, fromResolvedAt: Date | null, to: SupportTicketStatus, now: Date): Date | null {
  const done = (s: SupportTicketStatus) => s === 'RESOLVED' || s === 'CLOSED';
  if (done(to)) return done(from) ? fromResolvedAt ?? now : now;
  return null;
}
