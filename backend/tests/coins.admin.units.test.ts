import { describe, expect, it } from 'vitest';
import { coinAdjustSchema, giftAdminPatchSchema, giftAdminSchema, packageAdminPatchSchema, packageAdminSchema } from '../src/modules/coins/coins.schemas';

const gift = { code: 'HEART', name: 'Cœur', symbol: '❤️', meaning: 'Amour', pricePoints: 10, rarity: 'COMMON' };
const pack = { code: 'COINS_500', name: '500 Coins', points: 500, priceAmount: 500, currency: 'XAF', bonusPoints: 0 };

describe('étape 3 — cadeaux administrables', () => {
  it('accepte un cadeau valide', () => {
    expect(giftAdminSchema.safeParse(gift).success).toBe(true);
  });
  it('refuse un prix nul ou négatif', () => {
    expect(giftAdminSchema.safeParse({ ...gift, pricePoints: 0 }).success).toBe(false);
    expect(giftAdminSchema.safeParse({ ...gift, pricePoints: -5 }).success).toBe(false);
  });
  it('refuse une rareté hors liste', () => {
    expect(giftAdminSchema.safeParse({ ...gift, rarity: 'MYTHIC' }).success).toBe(false);
  });
  it('refuse un code en minuscules ou invalide', () => {
    expect(giftAdminSchema.safeParse({ ...gift, code: 'heart' }).success).toBe(false);
    expect(giftAdminSchema.safeParse({ ...gift, code: 'A B' }).success).toBe(false);
  });
  it('impose le format de la clé d’animation', () => {
    expect(giftAdminSchema.safeParse({ ...gift, animationKey: 'heart_01' }).success).toBe(true);
    expect(giftAdminSchema.safeParse({ ...gift, animationKey: 'Heart Big!' }).success).toBe(false);
    expect(giftAdminSchema.safeParse({ ...gift, animationKey: null }).success).toBe(true);
  });
  it('applique la rareté COMMON par défaut à la création', () => {
    const { rarity: _r, ...noRarity } = gift;
    const parsed = giftAdminSchema.safeParse(noRarity);
    expect(parsed.success && parsed.data.rarity).toBe('COMMON');
  });
  it('la modification est partielle et ne change jamais le code', () => {
    expect(giftAdminPatchSchema.safeParse({ active: false }).success).toBe(true);
    expect(giftAdminPatchSchema.safeParse({ pricePoints: 20 }).success).toBe(true);
    expect(giftAdminPatchSchema.safeParse({ code: 'NEW_CODE' }).success).toBe(false);
  });
});

describe('étape 3 — packs administrables', () => {
  it('accepte un pack valide en XAF ou XOF', () => {
    expect(packageAdminSchema.safeParse(pack).success).toBe(true);
    expect(packageAdminSchema.safeParse({ ...pack, currency: 'XOF' }).success).toBe(true);
  });
  it('refuse une devise non prise en charge par le Mobile Money', () => {
    expect(packageAdminSchema.safeParse({ ...pack, currency: 'USD' }).success).toBe(false);
    expect(packageAdminSchema.safeParse({ ...pack, currency: 'EUR' }).success).toBe(false);
  });
  it('refuse un prix ou des points nuls', () => {
    expect(packageAdminSchema.safeParse({ ...pack, priceAmount: 0 }).success).toBe(false);
    expect(packageAdminSchema.safeParse({ ...pack, points: 0 }).success).toBe(false);
  });
  it('la modification est partielle', () => {
    expect(packageAdminPatchSchema.safeParse({ active: false, sortOrder: 2 }).success).toBe(true);
    expect(packageAdminPatchSchema.safeParse({ currency: 'USD' }).success).toBe(false);
  });
});

describe('étape 3 — ajustement de solde', () => {
  it('accepte un ajustement positif ou négatif avec un motif', () => {
    expect(coinAdjustSchema.safeParse({ amount: 500, reason: 'Compensation panne paiement' }).success).toBe(true);
    expect(coinAdjustSchema.safeParse({ amount: -200, reason: 'Correction doublon' }).success).toBe(true);
  });
  it('refuse un ajustement sans motif ou avec un motif trop court', () => {
    expect(coinAdjustSchema.safeParse({ amount: 500 }).success).toBe(false);
    expect(coinAdjustSchema.safeParse({ amount: 500, reason: 'ok' }).success).toBe(false);
  });
  it('refuse un montant nul ou non entier', () => {
    expect(coinAdjustSchema.safeParse({ amount: 0, reason: 'Motif valable' }).success).toBe(false);
    expect(coinAdjustSchema.safeParse({ amount: 1.5, reason: 'Motif valable' }).success).toBe(false);
  });
});
