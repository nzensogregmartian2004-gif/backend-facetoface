import { EventEmitter } from 'node:events';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import type { MobileOperator } from '../../utils/payments';

/**
 * Client HTTP de l'API MyPVit (https://docs.mypvit.pro), repris du module éprouvé de l'application AIFI et adapté.
 *  - clé secrète (renew-secret) : renouvelée par compte opérateur ; selon le compte MyPVit, elle arrive dans la réponse HTTP
 *    OU de façon asynchrone sur le webhook « réception » (POST /api/webhooks/mypvit/secret/<jeton>) ;
 *  - paiement (/rest, transaction_type PAYMENT) : asynchrone, statut final par webhook de callback.
 * Les comptes et operator_code carte sont configurables : les valeurs réelles fournies par MPVIT sont placées dans l'ENV.
 *
 * Classification d'une demande de paiement (essentielle : on ne rejoue jamais un paiement dont le sort est inconnu) :
 *   - exception AppError  → rien n'est parti (clé secrète indisponible…) ;
 *   - REJECTED            → le prestataire a répondu par un refus net (HTTP 4xx avec corps) : aucun débit ;
 *   - UNCERTAIN           → la requête est partie mais la réponse est perdue (réseau, délai, HTTP 5xx, corps illisible) ;
 *   - ACCEPTED            → demande enregistrée ; le résultat arrivera par webhook.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const SECRET_WAIT_MS = 15_000;

const secretEvents = new EventEmitter();
secretEvents.setMaxListeners(50);
const pendingAccounts: MobileOperator[] = []; // comptes en attente d'une clé par webhook (repli quand MyPVit n'indique pas le compte)
const cachedSecrets: Partial<Record<MobileOperator, { value: string; expiresAt: number }>> = {};
/** Tests uniquement. */
export const __resetMypvitState = () => { pendingAccounts.length = 0; for (const k of Object.keys(cachedSecrets)) delete cachedSecrets[k as MobileOperator]; };

export const accountCodeOf = (op: MobileOperator): string | undefined => {
  switch (op) {
    case 'AIRTEL_MONEY': return env.MYPVIT_ACCOUNT_AIRTEL;
    case 'MOOV_MONEY': return env.MYPVIT_ACCOUNT_MOOV;
    case 'VISA': return env.MYPVIT_ACCOUNT_VISA;
    case 'MASTERCARD': return env.MYPVIT_ACCOUNT_MASTERCARD;
  }
};

export const operatorCodeOf = (op: MobileOperator): string => {
  switch (op) {
    case 'AIRTEL_MONEY': return 'AIRTEL_MONEY';
    case 'MOOV_MONEY': return 'MOOV_MONEY';
    case 'VISA': return env.MYPVIT_OPERATOR_VISA;
    case 'MASTERCARD': return env.MYPVIT_OPERATOR_MASTERCARD;
  }
};

/** Mobile money : le compte suffit. Carte : il faut aussi le lien de paiement et les deux codes de redirection. */
export const isOperatorConfigured = (op: MobileOperator) => {
  if (!accountCodeOf(op)) return false;
  if (op === 'VISA' || op === 'MASTERCARD') return !!(env.MYPVIT_URLCODE_LINK && env.MYPVIT_REDIRECT_SUCCESS_URL_CODE && env.MYPVIT_REDIRECT_FAILED_URL_CODE);
  return true;
};


const notSent = (message: string) => new AppError(502, 'PAYMENT_PROVIDER_ERROR', message);

async function http(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

/** Appelée par la route webhook quand MyPVit envoie la clé secrète de façon asynchrone (`accountCode` : operationAccountCode du payload, s'il est présent). */
export function receiveSecretFromWebhook(secretValue: string, expiresInSeconds = 3000, accountCode?: string | null) {
  const expiresAt = Date.now() + Math.max(expiresInSeconds - 300, 60) * 1000;
  let op: MobileOperator | undefined = accountCode ? (['AIRTEL_MONEY', 'MOOV_MONEY', 'VISA', 'MASTERCARD'] as MobileOperator[]).find((o) => accountCodeOf(o) === accountCode) : undefined;
  if (op) { const i = pendingAccounts.indexOf(op); if (i !== -1) pendingAccounts.splice(i, 1); } else op = pendingAccounts.shift();
  if (!op) { console.warn('[mypvit] clé secrète reçue sans demande en attente correspondante : ignorée'); return; }
  cachedSecrets[op] = { value: secretValue, expiresAt };
  secretEvents.emit(`secret:${op}`, secretValue);
}

function waitForWebhookSecret(op: MobileOperator): Promise<string> {
  pendingAccounts.push(op);
  const eventName = `secret:${op}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secretEvents.off(eventName, onSecret);
      const i = pendingAccounts.indexOf(op); if (i !== -1) pendingAccounts.splice(i, 1);
      reject(notSent("MyPVit n'a pas envoyé la clé secrète dans le délai imparti : vérifiez l'URL de réception enregistrée chez MyPVit (MYPVIT_RECEPTION_URL_CODE)"));
    }, SECRET_WAIT_MS);
    function onSecret(v: string) { clearTimeout(timer); resolve(v); }
    secretEvents.once(eventName, onSecret);
  });
}

async function fetchNewSecret(op: MobileOperator): Promise<string> {
  const accountCode = accountCodeOf(op);
  if (!accountCode) throw notSent(`Le compte MyPVit ${op} n'est pas configuré`);
  const url = `${env.MYPVIT_BASE_URL}/v2/${env.MYPVIT_URLCODE_RENEW_SECRET}/renew-secret`;
  const body = new URLSearchParams({ operationAccountCode: accountCode, password: env.MYPVIT_API_PASSWORD ?? '', receptionUrlCode: env.MYPVIT_RECEPTION_URL_CODE ?? '' });
  const waiter = waitForWebhookSecret(op); // on écoute AVANT d'envoyer : MyPVit peut répondre par webhook très vite
  waiter.catch(() => {});
  let res: Response;
  try { res = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
  catch { const i = pendingAccounts.indexOf(op); if (i !== -1) pendingAccounts.splice(i, 1); throw notSent('MyPVit est injoignable (renouvellement de la clé)'); }
  if (!res.ok) { const i = pendingAccounts.indexOf(op); if (i !== -1) pendingAccounts.splice(i, 1); throw notSent(`MyPVit a refusé le renouvellement de la clé (HTTP ${res.status})`); }
  const data = (await res.json().catch(() => null)) as { secret?: string; expires_in?: number } | null;
  if (data?.secret) {
    const i = pendingAccounts.indexOf(op); if (i !== -1) pendingAccounts.splice(i, 1);
    cachedSecrets[op] = { value: data.secret, expiresAt: Date.now() + ((data.expires_in || 3000) - 300) * 1000 };
    return data.secret;
  }
  return waiter; // la clé arrive sur le webhook de réception
}

export async function getSecret(op: MobileOperator, forceRenew = false): Promise<string> {
  const c = cachedSecrets[op];
  if (!forceRenew && c && c.expiresAt > Date.now()) return c.value;
  return fetchNewSecret(op);
}

/** Chiffres uniquement (le format exact attendu par MyPVit — avec ou sans indicatif — est celui que vous envoyez déjà dans l'application AIFI). */
export const normalizePhone = (raw: string) => raw.replace(/\D/g, '');

export type MypvitInit = { status: 'ACCEPTED'; providerRef: string | null } | { status: 'REJECTED'; code: string; message: string } | { status: 'UNCERTAIN' };
/** Carte : le client doit ouvrir cette page de paiement MyPVit ; le statut final arrive par webhook. */
export type MypvitCheckout = { status: 'REDIRECT'; url: string; providerRef: string | null };

type InitParams = { amount: number; phone: string; reference: string; operator: MobileOperator; freeInfo: string };

export async function initiatePayment(p: InitParams, retry = true): Promise<MypvitInit> {
  if (p.operator === 'VISA' || p.operator === 'MASTERCARD') throw notSent('Les paiements par carte passent par le lien de paiement MyPVit');
  const secret = await getSecret(p.operator); // peut lever AppError : rien n'est parti
  const url = `${env.MYPVIT_BASE_URL}/v2/${env.MYPVIT_URLCODE_REST}/rest`;
  let res: Response;
  try {
    res = await http(url, {
      method: 'POST',
      headers: { 'X-Secret': secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: env.MYPVIT_AGENT, amount: p.amount, callback_url_code: env.MYPVIT_CALLBACK_URL_CODE,
        customer_account_number: p.phone, merchant_operation_account_code: accountCodeOf(p.operator),
        transaction_type: 'PAYMENT', owner_charge: env.PAYMENT_FEE_PAYER, owner_charge_operator: env.PAYMENT_FEE_PAYER,
        free_info: p.freeInfo, product: env.MYPVIT_PRODUCT, operator_code: operatorCodeOf(p.operator), reference: p.reference, service: 'RESTFUL',
      }),
    });
  } catch { return { status: 'UNCERTAIN' }; } // réseau coupé ou délai dépassé : la demande est peut-être arrivée
  if (res.status === 401 && retry) { await getSecret(p.operator, true); return initiatePayment(p, false); } // clé expirée : un seul renouvellement
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 500) return { status: 'UNCERTAIN' };
  if (!res.ok) return { status: 'REJECTED', code: String(data?.status_code ?? data?.code ?? res.status), message: String(data?.message ?? 'Paiement refusé') };
  if (!data) return { status: 'UNCERTAIN' };
  const st = String(data.status ?? '').toUpperCase();
  if (['FAILED', 'ERROR', 'REJECTED'].includes(st)) return { status: 'REJECTED', code: String(data.status_code ?? st), message: String(data.message ?? 'Paiement refusé') };
  return { status: 'ACCEPTED', providerRef: typeof data.reference_id === 'string' ? data.reference_id : null };
}

/**
 * État d'une transaction. ⚠️ Le format de l'API « status » n'est PAS publié par MyPVit : implémentation prudente reprise de l'application AIFI
 * (jamais confirmée). Réponse inattendue → null (« inconnu »), jamais une supposition : on ne crédite jamais sur une ambiguïté.
 * Désactivée si MYPVIT_URLCODE_STATUS est absent.
 */
export async function checkTransactionStatus(reference: string, op: MobileOperator): Promise<'SUCCESS' | 'FAILED' | 'PENDING' | null> {
  if (!env.MYPVIT_URLCODE_STATUS) return null;
  try {
    const secret = await getSecret(op);
    const accountCode = accountCodeOf(op);
    const res = await http(`${env.MYPVIT_BASE_URL}/${env.MYPVIT_URLCODE_STATUS}/status`, {
      method: 'POST',
      headers: { 'X-Secret': secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, merchant_reference_id: reference, merchantReferenceId: reference, operation_account_code: accountCode, operationAccountCode: accountCode }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return null;
    const st = String(data.status ?? data.transaction_status ?? data.transactionStatus ?? '').toUpperCase();
    return st === 'SUCCESS' || st === 'FAILED' || st === 'PENDING' ? st : null;
  } catch { return null; }
}

type CardParams = { amount: number; phone: string; reference: string; operator: 'VISA' | 'MASTERCARD'; freeInfo: string };

/**
 * Paiement par carte (service VISA_MASTERCARD) : le lien renvoie une URL de paiement MyPVit vers laquelle le client est redirigé.
 * Le statut final arrive par webhook, comme pour le mobile money. Mêmes règles : jamais de succès sur la seule réponse, pas de rejeu automatique.
 */
export async function initiateCardLink(p: CardParams, retry = true): Promise<MypvitInit | MypvitCheckout> {
  const secret = await getSecret(p.operator); // peut lever AppError : rien n'est parti
  const url = `${env.MYPVIT_BASE_URL}/${env.MYPVIT_URLCODE_LINK}/link`;
  let res: Response;
  try {
    res = await http(url, {
      method: 'POST',
      headers: { 'X-Secret': secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: env.MYPVIT_AGENT, amount: p.amount, product: env.MYPVIT_PRODUCT, reference: p.reference, service: 'VISA_MASTERCARD',
        callback_url_code: env.MYPVIT_CALLBACK_URL_CODE, customer_account_number: p.phone,
        merchant_operation_account_code: accountCodeOf(p.operator), transaction_type: 'PAYMENT',
        owner_charge: env.PAYMENT_FEE_PAYER, owner_charge_operator: env.PAYMENT_FEE_PAYER, free_info: p.freeInfo,
        success_redirection_url_code: env.MYPVIT_REDIRECT_SUCCESS_URL_CODE, failed_redirection_url_code: env.MYPVIT_REDIRECT_FAILED_URL_CODE,
      }),
    });
  } catch { return { status: 'UNCERTAIN' }; }
  if (res.status === 401 && retry) { await getSecret(p.operator, true); return initiateCardLink(p, false); }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 500) return { status: 'UNCERTAIN' };
  if (!res.ok) return { status: 'REJECTED', code: String(data?.status_code ?? data?.code ?? res.status), message: String(data?.message ?? 'Paiement refusé') };
  if (!data) return { status: 'UNCERTAIN' };
  const st = String(data.status ?? '').toUpperCase();
  if (['FAILED', 'ERROR', 'REJECTED'].includes(st)) return { status: 'REJECTED', code: String(data.status_code ?? st), message: String(data.message ?? 'Paiement refusé') };
  const checkout = data.url;
  if (typeof checkout === 'string' && checkout) {
    return { status: 'REDIRECT', url: checkout, providerRef: typeof data.merchantReferenceId === 'string' ? data.merchantReferenceId : null };
  }
  return { status: 'UNCERTAIN' };
}

export type GiveChangeParams = {
  amount: number; phone: string; reference: string; operator: MobileOperator; freeInfo: string;
  /** Qui supporte les frais de la transaction : décision métier, jamais une valeur par défaut. */
  ownerCharge: 'CUSTOMER' | 'MERCHANT'; ownerChargeOperator: 'CUSTOMER' | 'MERCHANT';
};
export type GiveChangeResult = { status: 'SUCCESS'; providerRef: string | null } | { status: 'FAILED'; code: string; message: string } | { status: 'UNCERTAIN' };

/**
 * Remboursement GIVE_CHANGE (documentation MyPVit : traitement synchrone, la réponse porte le statut final, aucun webhook).
 * Jamais rejoué automatiquement : en cas de doute (réseau, 5xx), UNCERTAIN, à rapprocher manuellement.
 * Pas encore branché sur une route : il ne doit l'être qu'après validation avec le compte réel (matrice QA, cas 13).
 */
export async function giveChange(p: GiveChangeParams, retry = true): Promise<GiveChangeResult> {
  if (p.operator === 'VISA' || p.operator === 'MASTERCARD') throw notSent('Remboursement par carte non configuré');
  const secret = await getSecret(p.operator);
  const url = `${env.MYPVIT_BASE_URL}/v2/${env.MYPVIT_URLCODE_REST}/rest`;
  let res: Response;
  try {
    res = await http(url, {
      method: 'POST',
      headers: { 'X-Secret': secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: env.MYPVIT_AGENT, amount: p.amount, product: env.MYPVIT_PRODUCT, reference: p.reference, service: 'RESTFUL',
        callback_url_code: env.MYPVIT_CALLBACK_URL_CODE, customer_account_number: p.phone,
        merchant_operation_account_code: accountCodeOf(p.operator), transaction_type: 'GIVE_CHANGE',
        owner_charge: p.ownerCharge, owner_charge_operator: p.ownerChargeOperator, free_info: p.freeInfo, operator_code: operatorCodeOf(p.operator),
      }),
    });
  } catch { return { status: 'UNCERTAIN' }; }
  if (res.status === 401 && retry) { await getSecret(p.operator, true); return giveChange(p, false); }
  if (res.status >= 500) return { status: 'UNCERTAIN' };
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) return { status: 'UNCERTAIN' };
  const st = String(data.status ?? '').toUpperCase();
  if (st === 'SUCCESS') return { status: 'SUCCESS', providerRef: typeof data.reference_id === 'string' ? data.reference_id : null };
  if (st === 'FAILED' || st === 'ERROR' || st === 'REJECTED' || !res.ok) {
    return { status: 'FAILED', code: String(data.status_code ?? st ?? res.status), message: String(data.message ?? 'Remboursement refusé') };
  }
  return { status: 'UNCERTAIN' };
}
