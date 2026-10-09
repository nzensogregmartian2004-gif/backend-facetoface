import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { requirePermission } from '../admin/roles';
import type { AdminPermission } from '../admin/permissions';

const db = prisma;
/** Plafond d'un ajustement manuel de solde, en coins, dans un sens comme dans l'autre. Fixe pour l'instant ; configurable à l'étape 17. */
export const MAX_ADJUSTMENT = 10_000;

const guard = (user: User, p: AdminPermission) => { requirePermission(user, p); };
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const snapshot = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const uniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';
const GIFT_KEYS = ['code', 'name', 'symbol', 'meaning', 'pricePoints', 'rarity', 'animationKey', 'imageKey', 'active', 'sortOrder'] as const;
const PACKAGE_KEYS = ['code', 'name', 'points', 'priceAmount', 'currency', 'bonusPoints', 'active', 'sortOrder'] as const;

type Input = Record<string, unknown> & { reason?: string };

/** Création ou modification d'un cadeau. Désactiver = `active: false` (jamais de suppression). Chaque changement est journalisé (avant / après) dans la même transaction. */
export async function upsertGift(user: User, id: string | undefined, input: Input) {
  guard(user, 'finance.gifts.prices.update');
  const { reason, ...data } = input;
  try {
    return await db.$transaction(async (tx) => {
      if (id) {
        const before = await tx.gift.findUnique({ where: { id } });
        if (!before) throw notFound('Cadeau introuvable');
        const after = await tx.gift.update({ where: { id }, data: data as unknown as Prisma.GiftUpdateInput });
        await tx.adminAuditLog.create({ data: { adminId: user.id, action: 'COINS_GIFT_UPDATE', targetType: 'GIFT', targetId: id, reason: reason ?? null, metadata: json({ before: snapshot(before, GIFT_KEYS), after: snapshot(after, GIFT_KEYS) }) } });
        return after;
      }
      const created = await tx.gift.create({ data: data as unknown as Prisma.GiftCreateInput });
      await tx.adminAuditLog.create({ data: { adminId: user.id, action: 'COINS_GIFT_CREATE', targetType: 'GIFT', targetId: created.id, reason: reason ?? null, metadata: json({ after: snapshot(created, GIFT_KEYS) }) } });
      return created;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('CODE_EXISTS', 'Ce code existe déjà');
    throw e;
  }
}

/** Création ou modification d'un pack de coins. Même règles de journalisation que les cadeaux. */
export async function upsertPackage(user: User, id: string | undefined, input: Input) {
  guard(user, 'finance.coins.update');
  const { reason, ...data } = input;
  try {
    return await db.$transaction(async (tx) => {
      if (id) {
        const before = await tx.coinPackage.findUnique({ where: { id } });
        if (!before) throw notFound('Pack introuvable');
        const after = await tx.coinPackage.update({ where: { id }, data: data as unknown as Prisma.CoinPackageUpdateInput });
        await tx.adminAuditLog.create({ data: { adminId: user.id, action: 'COINS_PACKAGE_UPDATE', targetType: 'COIN_PACKAGE', targetId: id, reason: reason ?? null, metadata: json({ before: snapshot(before, PACKAGE_KEYS), after: snapshot(after, PACKAGE_KEYS) }) } });
        return after;
      }
      const created = await tx.coinPackage.create({ data: data as unknown as Prisma.CoinPackageCreateInput });
      await tx.adminAuditLog.create({ data: { adminId: user.id, action: 'COINS_PACKAGE_CREATE', targetType: 'COIN_PACKAGE', targetId: created.id, reason: reason ?? null, metadata: json({ after: snapshot(created, PACKAGE_KEYS) }) } });
      return created;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict('CODE_EXISTS', 'Ce code existe déjà');
    throw e;
  }
}

/** Solde et derniers mouvements d'un utilisateur, pour le support. */
export async function userCoins(admin: User, targetUserId: string) {
  guard(admin, 'finance.coins.view');
  const target = await db.user.findUnique({ where: { id: targetUserId }, select: { id: true, username: true, displayName: true } });
  if (!target) throw notFound('Utilisateur introuvable');
  const wallet = await db.coinWallet.findUnique({ where: { userId: targetUserId } });
  const entries = await db.coinLedgerEntry.findMany({ where: { userId: targetUserId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return { user: target, balance: wallet?.balance ?? 0, entries };
}

/**
 * Ajustement manuel du solde : motif obligatoire, montant borné par MAX_ADJUSTMENT, débit refusé sous zéro.
 * Dans une seule transaction : solde, ligne de grand livre (ADJUSTMENT) et journal d'audit.
 */
export async function adjustBalance(admin: User, targetUserId: string, input: { amount: number; reason: string }) {
  guard(admin, 'finance.coins.adjust');
  if (!Number.isInteger(input.amount) || input.amount === 0) throw badRequest('INVALID_AMOUNT', 'Montant invalide');
  if (Math.abs(input.amount) > MAX_ADJUSTMENT) throw badRequest('ADJUSTMENT_TOO_LARGE', `Ajustement limité à ${MAX_ADJUSTMENT} coins`, { max: MAX_ADJUSTMENT });
  if (!input.reason || input.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Motif obligatoire');
  const target = await db.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!target) throw notFound('Utilisateur introuvable');
  return db.$transaction(async (tx) => {
    const w = await tx.coinWallet.upsert({ where: { userId: targetUserId }, create: { userId: targetUserId }, update: {} });
    const before = w.balance;
    let after: number;
    if (input.amount > 0) {
      after = (await tx.coinWallet.update({ where: { id: w.id }, data: { balance: { increment: input.amount } } })).balance;
    } else {
      const r = await tx.coinWallet.updateMany({ where: { id: w.id, balance: { gte: -input.amount } }, data: { balance: { decrement: -input.amount } } });
      if (!r.count) throw conflict('INSUFFICIENT_COINS', 'Solde insuffisant pour ce débit', { balance: before, required: -input.amount });
      after = (await tx.coinWallet.findUniqueOrThrow({ where: { id: w.id } })).balance;
    }
    const log = await tx.adminAuditLog.create({ data: { adminId: admin.id, action: 'COINS_ADJUST', targetType: 'USER', targetId: targetUserId, reason: input.reason.trim(), metadata: json({ amount: input.amount, before, after }) } });
    await tx.coinLedgerEntry.create({ data: { walletId: w.id, userId: targetUserId, type: 'ADJUSTMENT', amount: input.amount, balanceAfter: after, sourceType: 'ADMIN_ADJUSTMENT', sourceId: log.id, description: `Ajustement administrateur : ${input.reason.trim()}` } });
    return { balance: after, adjustment: input.amount, auditId: log.id };
  });
}

/** Journal des modifications du catalogue et des ajustements (entrées COINS_*), les plus récentes d'abord. */
export async function coinsAudit(admin: User, limit = 50) {
  guard(admin, 'audit.view');
  const take = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
  const entries = await db.adminAuditLog.findMany({ where: { action: { startsWith: 'COINS_' } }, orderBy: { createdAt: 'desc' }, take, include: { admin: { select: { id: true, username: true, displayName: true } } } });
  return { entries };
}
