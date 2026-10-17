import { forbidden } from './errors';

/** Compte restreint : publication, commentaires, messages, lives et appels sont bloqués. Le reste reste accessible. */
export function assertNotRestricted(user: { restrictedAt?: Date | null }): void {
  if (user.restrictedAt) throw forbidden('ACCOUNT_RESTRICTED', 'Votre compte est restreint : publication, commentaires, messages, lives et appels sont désactivés.');
}
