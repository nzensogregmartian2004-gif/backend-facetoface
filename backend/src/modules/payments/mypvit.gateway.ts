import { operatorsForCountry } from '../geo/geo.service';
import type { InitiateRequest, InitiateResult, MobileOperator, PaymentGateway, RemoteStatus } from '../../utils/payments';
import { checkTransactionStatus, initiateCardLink, initiatePayment, isOperatorConfigured as configured, normalizePhone } from './mypvit.client';

export const isOperatorConfigured = configured;

/** Pilote `mypvit` : mobile money par /rest (statut final par webhook), carte par /link (redirection vers la page MyPVit). */
export class MypvitGateway implements PaymentGateway {
  readonly name = 'mypvit';
  /** Opérateurs configurés, restreints à ceux du pays quand une table existe pour ce pays (sinon : tous les configurés). */
  operators(country?: string | null): MobileOperator[] {
    const configuredOps = (['AIRTEL_MONEY', 'MOOV_MONEY', 'VISA', 'MASTERCARD'] as MobileOperator[]).filter(configured);
    const allowed = operatorsForCountry(country);
    return allowed ? configuredOps.filter((o) => allowed.includes(o)) : configuredOps;
  }
  async initiate(req: InitiateRequest): Promise<InitiateResult> {
    if (req.operator === 'VISA' || req.operator === 'MASTERCARD') {
      return initiateCardLink({ amount: req.amount, phone: normalizePhone(req.phone), reference: req.reference, operator: req.operator, freeInfo: req.description.slice(0, 40) });
    }
    return initiatePayment({ amount: req.amount, phone: normalizePhone(req.phone), reference: req.reference, operator: req.operator, freeInfo: req.description.slice(0, 40) });
  }
  checkStatus(reference: string, operator: MobileOperator): Promise<RemoteStatus | null> { return checkTransactionStatus(reference, operator); }
}
