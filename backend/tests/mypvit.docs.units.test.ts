import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { __resetMypvitState, giveChange, initiateCardLink, isOperatorConfigured } from '../src/modules/payments/mypvit.client';

const e = env as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const set = (k: string, v: unknown) => { saved[k] = e[k]; e[k] = v; };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let calls: { url: string; init: RequestInit }[] = [];
const stub = (handler: (url: string) => Response | Promise<Response>) => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url); }));
};
/** Le renouvellement de clé secrète passe toujours ; seul l'appel testé varie. */
const withSecret = (rest: (url: string) => Response) => (url: string) =>
  (url.includes('/renew-secret') ? json(200, { secret: 'SEC1', expires_in: 3600, operation_account_code: 'ACC_X' }) : rest(url));
const body = (c: { init: RequestInit }) => JSON.parse(c.init.body as string);

beforeEach(() => {
  __resetMypvitState();
  set('MYPVIT_BASE_URL', 'https://mypvit.test'); set('MYPVIT_API_PASSWORD', 'pw'); set('MYPVIT_URLCODE_RENEW_SECRET', 'RENEW');
  set('MYPVIT_URLCODE_REST', 'REST'); set('MYPVIT_URLCODE_LINK', 'LINK'); set('MYPVIT_CALLBACK_URL_CODE', 'CB'); set('MYPVIT_RECEPTION_URL_CODE', 'RECEP');
  set('MYPVIT_REDIRECT_SUCCESS_URL_CODE', 'OK'); set('MYPVIT_REDIRECT_FAILED_URL_CODE', 'KO');
  set('MYPVIT_ACCOUNT_AIRTEL', 'ACC_AIRTEL'); set('MYPVIT_ACCOUNT_VISA', 'ACC_VISA');
});
afterEach(() => { vi.unstubAllGlobals(); for (const [k, v] of Object.entries(saved)) e[k] = v; });

const CARD = { amount: 1000, phone: '074111111', reference: 'KCARD0000001', operator: 'VISA' as const, freeInfo: 'Achat de coins' };
const REFUND = { amount: 500, phone: '074111111', reference: 'KREF00000001', operator: 'AIRTEL_MONEY' as const, freeInfo: 'Remboursement', ownerCharge: 'MERCHANT' as const, ownerChargeOperator: 'CUSTOMER' as const };

describe('carte par lien de paiement (documentation MyPVit)', () => {
  it('demande conforme : /link sans /v2, service VISA_MASTERCARD, numéro client, redirections', async () => {
    stub(withSecret(() => json(200, { url: 'https://checkout.test/PAY1', merchantReferenceId: 'KCARD0000001', status: 'SUCCESS', statusCode: 200 })));
    expect(await initiateCardLink(CARD)).toEqual({ status: 'REDIRECT', url: 'https://checkout.test/PAY1', providerRef: 'KCARD0000001' });
    const link = calls.find((c) => c.url.includes('/link'))!;
    expect(link.url).toBe('https://mypvit.test/LINK/link');
    expect(body(link)).toMatchObject({ service: 'VISA_MASTERCARD', customer_account_number: '074111111', transaction_type: 'PAYMENT', reference: 'KCARD0000001', success_redirection_url_code: 'OK', failed_redirection_url_code: 'KO', merchant_operation_account_code: 'ACC_VISA' });
    expect(calls.some((c) => c.url.includes('/v2/REST/rest'))).toBe(false);
  });

  it('un refus net du prestataire est un REJECTED, jamais un REDIRECT', async () => {
    stub(withSecret(() => json(200, { status: 'FAILED', status_code: '402', message: 'Carte refusée' })));
    expect(await initiateCardLink(CARD)).toEqual({ status: 'REJECTED', code: '402', message: 'Carte refusée' });
  });

  it('erreur serveur : UNCERTAIN, et aucun second envoi (pas de double débit possible)', async () => {
    stub(withSecret(() => json(500, { message: 'erreur' })));
    expect(await initiateCardLink(CARD)).toEqual({ status: 'UNCERTAIN' });
    expect(calls.filter((c) => c.url.includes('/link'))).toHaveLength(1);
  });

  it('la carte n’est configurée que si le lien et les deux redirections le sont', () => {
    expect(isOperatorConfigured('VISA')).toBe(true);
    set('MYPVIT_URLCODE_LINK', undefined);
    expect(isOperatorConfigured('VISA')).toBe(false);
    expect(isOperatorConfigured('AIRTEL_MONEY')).toBe(true);
  });
});

describe('remboursement GIVE_CHANGE (synchrone, sans webhook)', () => {
  it('demande conforme : transaction GIVE_CHANGE, frais tels que décidés par l’appelant, opérateur', async () => {
    stub(withSecret(() => json(200, { status: 'SUCCESS', status_code: '200', operator: 'AIRTEL_MONEY', reference_id: 'PAY9' })));
    expect(await giveChange(REFUND)).toEqual({ status: 'SUCCESS', providerRef: 'PAY9' });
    const rest = calls.find((c) => c.url.endsWith('/v2/REST/rest'))!;
    expect(body(rest)).toMatchObject({ transaction_type: 'GIVE_CHANGE', service: 'RESTFUL', operator_code: 'AIRTEL_MONEY', owner_charge: 'MERCHANT', owner_charge_operator: 'CUSTOMER', reference: 'KREF00000001', amount: 500 });
  });

  it('refus du prestataire : FAILED avec son message', async () => {
    stub(withSecret(() => json(200, { status: 'FAILED', status_code: '409', message: 'Solde marchand insuffisant' })));
    expect(await giveChange(REFUND)).toEqual({ status: 'FAILED', code: '409', message: 'Solde marchand insuffisant' });
  });

  it('erreur serveur : UNCERTAIN, sans rejeu automatique', async () => {
    stub(withSecret(() => json(503, { message: 'indisponible' })));
    expect(await giveChange(REFUND)).toEqual({ status: 'UNCERTAIN' });
    expect(calls.filter((c) => c.url.endsWith('/v2/REST/rest'))).toHaveLength(1);
  });

  it('un remboursement par carte n’est pas envoyé', async () => {
    stub(withSecret(() => json(200, { status: 'SUCCESS' })));
    await expect(giveChange({ ...REFUND, operator: 'VISA' })).rejects.toThrow();
    expect(calls.filter((c) => c.url.endsWith('/v2/REST/rest'))).toHaveLength(0);
  });
});
