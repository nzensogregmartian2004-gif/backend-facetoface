import { COUNTRIES } from './countries.data';
import { OPERATORS_BY_COUNTRY } from './countryOperators';

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c] as const));

export const isKnownCountry = (code: string) => BY_CODE.has(code);

/** Devise par défaut d'un pays (ISO 4217), ou `null` si le pays est inconnu ou sans devise. */
export const currencyForCountry = (code: string | null | undefined): string | null =>
  (code ? BY_CODE.get(code)?.cur ?? null : null);

/** Liste publique des pays : Afrique d'abord, codes et noms FR/EN, devise par défaut. */
export const listCountries = () =>
  COUNTRIES.map((c) => ({ code: c.code, nameFr: c.fr, nameEn: c.en, currency: c.cur, africa: c.africa }));

/** Opérateurs définis pour ce pays, ou `null` si le pays n'a pas encore de table (repli : opérateurs configurés). */
export const operatorsForCountry = (code: string | null | undefined): string[] | null =>
  (code ? OPERATORS_BY_COUNTRY[code] ?? null : null);
