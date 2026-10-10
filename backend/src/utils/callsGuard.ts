import { AppError } from './errors';

/**
 * Garde de configuration des appels : sans fournisseur configuré (identifiants LiveKit absents), aucun appel
 * ne peut être créé ni rejoint. On répond 503 avec un code stable, au lieu d'une erreur interne au moment du jeton.
 */
export function assertCallsConfigured(configured: boolean): void {
  if (!configured) throw new AppError(503, 'CALLS_NOT_CONFIGURED', 'Les appels ne sont pas encore configurés sur ce serveur');
}
