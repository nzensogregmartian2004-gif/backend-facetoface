export const DEFAULT_CURRENCY = 'XAF';
export const DEFAULT_LANGUAGE = 'FR';

export function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Code devise ISO 4217 invalide');
  return currency;
}

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value.trim().toUpperCase());
}

export function listCurrencies(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf('currency').sort() : ['CAD', 'EUR', 'GBP', 'NGN', 'USD', 'XAF', 'XOF'];
}

export function formatMoney(amountMinor: number, currency: string, locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: normalizeCurrency(currency) }).format(amountMinor / 100);
}
