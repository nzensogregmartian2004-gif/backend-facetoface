import { describe, expect, it } from 'vitest';
import { aggregateCountries } from '../src/modules/audience/audience.service';

describe('étape 5 — agrégation de l’audience', () => {
  it('trie par nombre d’abonnés et calcule les pourcentages sur le total', () => {
    const r = aggregateCountries([{ country: 'GA', followers: 50 }, { country: 'CM', followers: 30 }, { country: 'SN', followers: 20 }], 5);
    expect(r.totalFollowers).toBe(100);
    expect(r.countries.map((c) => c.countryCode)).toEqual(['GA', 'CM', 'SN']);
    expect(r.countries.map((c) => c.percentage)).toEqual([50, 30, 20]);
  });

  it('regroupe dans « Autres » tout pays sous le seuil', () => {
    const r = aggregateCountries([{ country: 'GA', followers: 40 }, { country: 'FR', followers: 3 }, { country: 'BE', followers: 2 }], 5);
    expect(r.countries.map((c) => c.countryCode)).toEqual(['GA']);
    expect(r.others).toEqual({ followers: 5, percentage: 11.1 });
  });

  it('sépare les abonnés sans pays, et les regroupe s’ils sont sous le seuil', () => {
    const big = aggregateCountries([{ country: 'GA', followers: 10 }, { country: null, followers: 8 }], 5);
    expect(big.unknown).toEqual({ followers: 8, percentage: 44.4 });
    expect(big.others).toBeNull();
    const small = aggregateCountries([{ country: 'GA', followers: 10 }, { country: null, followers: 2 }], 5);
    expect(small.unknown).toBeNull();
    expect(small.others).toEqual({ followers: 2, percentage: 16.7 });
  });

  it('ignore les codes pays mal formés en les rangeant parmi les non renseignés', () => {
    const r = aggregateCountries([{ country: 'gabon', followers: 6 }, { country: 'GA', followers: 6 }], 5);
    expect(r.countries.map((c) => c.countryCode)).toEqual(['GA']);
    expect(r.unknown).toEqual({ followers: 6, percentage: 50 });
  });

  it('une audience vide donne des totaux nuls et aucun regroupement', () => {
    expect(aggregateCountries([], 5)).toEqual({ totalFollowers: 0, countries: [], others: null, unknown: null });
  });

  it('la sortie ne contient que des pays, des effectifs et des pourcentages', () => {
    const r = aggregateCountries([{ country: 'GA', followers: 9 }], 5);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual(['countries', 'others', 'totalFollowers', 'unknown']);
    expect(Object.keys(r.countries[0]).sort()).toEqual(['countryCode', 'followers', 'percentage']);
  });
});
