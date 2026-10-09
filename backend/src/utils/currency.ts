import { z } from 'zod';
import { env } from '../config/env';
import { AppError, badRequest } from './errors';

/**
 * Devises acceptées et unités mineures. XAF/XOF n'ont pas de centimes (5 000 = 5 000 FCFA) ;
 * EUR/USD ont 2 décimales (500 = 5,00 €). Tout montant stocké ou échangé est un entier en unités mineures.
 */
export const SUPPORTED_CURRENCIES = ['XAF', 'XOF', 'EUR', 'USD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'XAF';
export const currencySchema = z.enum(SUPPORTED_CURRENCIES, { message: 'Devise non prise en charge' });

const EXPONENT: Record<Currency, number> = { XAF: 0, XOF: 0, EUR: 2, USD: 2 };
export const currencyExponent = (c: string): number => EXPONENT[c as Currency] ?? 2;
export const isSupportedCurrency = (c: unknown): c is Currency => typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);

/** Mobile Money (MyPVit : Airtel Money / Moov Money) ne débite qu'en FCFA. */
export const isMobileMoneyCurrency = (c: string) => c === 'XAF' || c === 'XOF';
export function assertMobileMoneyCurrency(currency: string) {
  if (!isMobileMoneyCurrency(currency)) {
    throw new AppError(422, 'CURRENCY_NOT_PAYABLE', `Le paiement Mobile Money n'est possible qu'en FCFA. Le paiement en ${currency} sera disponible par carte bancaire.`);
  }
}

/**
 * Valeur d'un FCFA exprimée en `currency` (pour dériver les bornes min/max d'une devise à partir des limites FCFA de l'env).
 * EUR : parité fixe 655,957 XAF. USD : référence indicative `USD_XAF_REFERENCE_RATE` (à remplacer par la table ExchangeRate).
 * Ces taux ne servent QU'À borner des prix, jamais à convertir un paiement.
 */
function xafPerUnit(currency: Currency): number {
  switch (currency) {
    case 'XAF': case 'XOF': return 1;
    case 'EUR': return 655.957;
    case 'USD': return env.USD_XAF_REFERENCE_RATE;
  }
}

/** Convertit une limite exprimée en FCFA (env) vers les unités mineures de `currency`, arrondie à l'entier (minimum 1). */
export function limitIn(limitXaf: number, currency: string): number {
  const c = (isSupportedCurrency(currency) ? currency : DEFAULT_CURRENCY) as Currency;
  if (c === 'XAF' || c === 'XOF') return limitXaf;
  return Math.max(1, Math.round((limitXaf / xafPerUnit(c)) * 10 ** currencyExponent(c)));
}

/** Texte « 5 000 FCFA » / « 12,50 EUR » pour les messages d'erreur. */
export function formatAmountText(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const label = currency === 'XAF' || currency === 'XOF' ? 'FCFA' : currency;
  const value = (amountMinor / 10 ** exp).toFixed(exp);
  return `${exp === 0 ? Number(value).toLocaleString('fr-FR') : value.replace('.', ',')} ${label}`;
}

/** Vérifie qu'un prix (unités mineures) est dans [minXaf, maxXaf] converti dans la devise ; lève INVALID_PRICE sinon. */
export function assertPriceInRange(price: number, currency: string, minXaf: number, maxXaf: number, code = 'INVALID_PRICE', field = 'price') {
  const lo = limitIn(minXaf, currency);
  const hi = limitIn(maxXaf, currency);
  if (price < lo || price > hi) {
    throw badRequest(code, `Le prix doit être compris entre ${formatAmountText(lo, currency)} et ${formatAmountText(hi, currency)}`, { [field]: 'Montant hors limites' });
  }
}
