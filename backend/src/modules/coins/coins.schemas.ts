import { z } from 'zod';
const operator = z.enum(['AIRTEL_MONEY', 'MOOV_MONEY', 'VISA', 'MASTERCARD']);
const phone = z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform(v => v.replace(/\D/g, ''));
export const buyCoinsSchema = z.object({ packageId: z.string().min(1), operator, phone }).strict();
const idempotencyKey = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Clé d’idempotence invalide');
export const sendGiftSchema = z.object({ creatorId: z.string().min(1), giftId: z.string().min(1), quantity: z.number().int().min(1).max(100), liveId: z.string().min(1).optional(), message: z.string().trim().max(160).optional(), idempotencyKey: idempotencyKey.optional() }).strict();
export const sendTipSchema = z.object({ creatorId: z.string().min(1), amount: z.number().int().min(1), message: z.string().trim().max(160).optional(), liveId: z.string().min(1).optional(), idempotencyKey: idempotencyKey.optional() }).strict();
export const COIN_RARITIES = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
const adminReason = z.string().trim().min(3, 'Motif trop court').max(200);
const catalogCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code invalide (majuscules, chiffres et tirets bas)');
const animationKey = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Clé d’animation invalide (minuscules, chiffres, tirets et tirets bas)');
const giftBase = {
  name: z.string().trim().min(1).max(80),
  symbol: z.string().trim().min(1).max(8),
  meaning: z.string().trim().min(1).max(160),
  pricePoints: z.number().int().min(1).max(1_000_000),
  animationKey: animationKey.nullable().optional(),
  imageKey: z.string().trim().max(100).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  reason: adminReason.optional(),
};
export const giftAdminSchema = z.object({ code: catalogCode, rarity: z.enum(COIN_RARITIES).default('COMMON'), ...giftBase }).strict();
export const giftAdminPatchSchema = z.object({ rarity: z.enum(COIN_RARITIES), ...giftBase }).partial().strict();
const packageBase = {
  name: z.string().trim().min(1).max(80),
  points: z.number().int().min(1).max(10_000_000),
  priceAmount: z.number().int().min(1).max(100_000_000),
  currency: z.enum(['XAF', 'XOF'], { message: 'Devise non prise en charge pour les packs (Mobile Money)' }),
  bonusPoints: z.number().int().min(0).max(10_000_000),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  reason: adminReason.optional(),
};
export const packageAdminSchema = z.object({ code: catalogCode, ...packageBase, bonusPoints: z.number().int().min(0).max(10_000_000).default(0) }).strict();
export const packageAdminPatchSchema = z.object({ ...packageBase }).partial().strict();
export const coinAdjustSchema = z.object({
  amount: z.number().int().refine((v) => v !== 0, 'Montant nul'),
  reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(200),
}).strict();
