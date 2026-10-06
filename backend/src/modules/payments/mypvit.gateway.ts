import type { InitiateRequest, InitiateResult, MobileOperator, PaymentGateway, RemoteStatus } from '../../utils/payments';
import { checkTransactionStatus, initiatePayment, isOperatorConfigured as configured, normalizePhone } from './mypvit.client';

export const isOperatorConfigured = configured;

/** Pilote `mypvit` : adapte le client HTTP au port `PaymentGateway`. */
export class MypvitGateway implements PaymentGateway {
  readonly name = 'mypvit';
  operators(): MobileOperator[] { return (['AIRTEL_MONEY', 'MOOV_MONEY'] as MobileOperator[]).filter(configured); }
  async initiate(req: InitiateRequest): Promise<InitiateResult> {
    return initiatePayment({ amount: req.amountFcfa, phone: normalizePhone(req.phone), reference: req.reference, operator: req.operator, freeInfo: req.description.slice(0, 40) });
  }
  checkStatus(reference: string, operator: MobileOperator): Promise<RemoteStatus | null> { return checkTransactionStatus(reference, operator); }
}
