import { env } from '../config/env';
import { AppError } from './errors';
import { MypvitGateway, isOperatorConfigured } from '../modules/payments/mypvit.gateway';

/**
 * Passerelle de paiement (port). Les paiements Mobile Money sont ASYNCHRONES :
 *   initiate() → le client valide sur son téléphone → le prestataire appelle notre webhook → `settlePurchase` (PAID | FAILED).
 * `initiate` ne dit donc JAMAIS « payé » : il dit seulement si la demande a été acceptée, refusée ou si son sort est inconnu.
 *
 * Pilotes : `none` (503 : rien ne part), `memory` (tests), `mypvit` (Airtel Money, Moov Money).
 * ÉTAPE 13 : portefeuille, retraits, remboursements — derrière ce même port.
 */
export type MobileOperator = 'AIRTEL_MONEY' | 'MOOV_MONEY';
export const MOBILE_OPERATORS: readonly MobileOperator[] = ['AIRTEL_MONEY', 'MOOV_MONEY'];

export type InitiateRequest = { reference: string; amountFcfa: number; operator: MobileOperator; phone: string; description: string };
export type InitiateResult =
  | { status: 'ACCEPTED'; providerRef: string | null }
  /** Refus net du prestataire : aucun débit. L'achat passe en FAILED et peut être retenté. */
  | { status: 'REJECTED'; code: string; message: string }
  /** La demande est partie mais la réponse est perdue (délai dépassé, erreur serveur) : le client a PEUT-ÊTRE été débité. L'achat reste PENDING ; aucun nouvel essai tant que ce n'est pas tranché. */
  | { status: 'UNCERTAIN' };

export type RemoteStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface PaymentGateway {
  readonly name: string;
  /** Opérateurs réellement utilisables sur ce serveur. */
  operators(): MobileOperator[];
  /** Lève une AppError uniquement si RIEN n'a été envoyé au prestataire (non configuré, clé secrète indisponible…). */
  initiate(req: InitiateRequest): Promise<InitiateResult>;
  /** État chez le prestataire, ou null si inconnu (API de statut absente ou réponse ambiguë : jamais de supposition). */
  checkStatus(reference: string, operator: MobileOperator): Promise<RemoteStatus | null>;
}

export class UnconfiguredPayments implements PaymentGateway {
  readonly name = 'none';
  operators(): MobileOperator[] { return []; }
  async initiate(): Promise<InitiateResult> {
    throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
  }
  async checkStatus(): Promise<RemoteStatus | null> { return null; }
}

/** Pilote de test : accepte par défaut ; `rejectNext` / `uncertainNext` / `notSentNext` simulent les trois issues défavorables ; `setStatus` pilote `checkStatus`. */
export class MemoryPayments implements PaymentGateway {
  readonly name = 'memory';
  requests: InitiateRequest[] = [];
  private plan: ('ok' | 'reject' | 'uncertain' | 'not-sent')[] = [];
  private statuses = new Map<string, RemoteStatus | null>();
  checks: string[] = [];
  rejectNext() { this.plan.push('reject'); }
  uncertainNext() { this.plan.push('uncertain'); }
  notSentNext() { this.plan.push('not-sent'); }
  setStatus(reference: string, s: RemoteStatus | null) { this.statuses.set(reference, s); }
  clear() { this.requests = []; this.plan = []; this.statuses.clear(); this.checks = []; }
  operators(): MobileOperator[] { return [...MOBILE_OPERATORS]; }
  async initiate(req: InitiateRequest): Promise<InitiateResult> {
    const step = this.plan.shift() ?? 'ok';
    if (step === 'not-sent') throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Le prestataire de paiement est indisponible, réessayez');
    this.requests.push(req); // la demande est « partie » dans les trois cas suivants
    if (step === 'reject') return { status: 'REJECTED', code: 'INSUFFICIENT_FUNDS', message: 'Solde insuffisant' };
    if (step === 'uncertain') return { status: 'UNCERTAIN' };
    return { status: 'ACCEPTED', providerRef: `mem_${req.reference}` };
  }
  async checkStatus(reference: string): Promise<RemoteStatus | null> {
    this.checks.push(reference);
    return this.statuses.get(reference) ?? null;
  }
}

function create(): PaymentGateway {
  if (env.PAYMENT_DRIVER === 'memory') return new MemoryPayments();
  if (env.PAYMENT_DRIVER === 'mypvit') return new MypvitGateway();
  return new UnconfiguredPayments();
}
export const payments: PaymentGateway = create();
export { isOperatorConfigured };
