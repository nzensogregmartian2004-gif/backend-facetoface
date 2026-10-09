import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { normalizeCurrency } from '../monetization/currency';

const db = prisma;

type DB = Prisma.TransactionClient | typeof prisma;

export async function ensureWallet(tx: DB, userId: string, currencyInput: string) {
  const currency = normalizeCurrency(currencyInput);
  return tx.wallet.upsert({
    where: { userId_currency: { userId, currency } },
    create: { userId, currency },
    update: {},
  });
}

/** Ajoute un revenu reconnu au portefeuille sans jamais créditer deux fois la même source. */
export async function creditCreatorWallet(tx: DB, input: { creatorId: string; sourceType: string; sourceId: string; amount: number; currency: string; pending?: boolean; description?: string }) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return null;
  const wallet = await ensureWallet(tx, input.creatorId, input.currency);
  const existing = await tx.walletLedgerEntry.findFirst({ where: { sourceType: input.sourceType, sourceId: input.sourceId, type: 'EARNING' } });
  if (existing) return existing;
  const pending = input.pending ?? false;
  const next = pending ? wallet.pendingAmount + input.amount : wallet.availableAmount + input.amount;
  const updated = await tx.wallet.update({ where: { id: wallet.id }, data: pending ? { pendingAmount: next } : { availableAmount: next } });
  return tx.walletLedgerEntry.create({ data: { walletId: wallet.id, userId: input.creatorId, type: 'EARNING', amount: input.amount, balanceAfter: pending ? updated.pendingAmount : updated.availableAmount, currency: wallet.currency, sourceType: input.sourceType, sourceId: input.sourceId, description: input.description } });
}

export async function getWallet(user: User, currencyInput?: string) {
  const where = { userId: user.id, ...(currencyInput ? { currency: normalizeCurrency(currencyInput) } : {}) };
  const wallets = await db.wallet.findMany({ where, orderBy: { currency: 'asc' } });
  return { wallets };
}

export async function getTransactions(user: User, currencyInput?: string, status?: string, limit = 50) {
  const currency = currencyInput ? normalizeCurrency(currencyInput) : undefined;
  const rows = await db.financialTransaction.findMany({
    where: { userId: user.id, ...(currency ? { currency } : {}), ...(status ? { status: status as any } : {}) },
    orderBy: { createdAt: 'desc' }, take: limit,
  });
  return { transactions: rows };
}

export async function getLedger(user: User, currencyInput?: string, limit = 100) {
  const currency = currencyInput ? normalizeCurrency(currencyInput) : undefined;
  const rows = await db.walletLedgerEntry.findMany({ where: { userId: user.id, ...(currency ? { currency } : {}) }, orderBy: { createdAt: 'desc' }, take: limit });
  return { entries: rows };
}

export async function getWithdrawals(user: User, currencyInput?: string, limit = 50) {
  const currency = currencyInput ? normalizeCurrency(currencyInput) : undefined;
  return { withdrawals: await db.withdrawal.findMany({ where: { userId: user.id, ...(currency ? { currency } : {}) }, orderBy: { requestedAt: 'desc' }, take: limit }) };
}

export async function requestWithdrawal(user: User, input: { amount: number; currency: string; method: 'MOBILE_MONEY'|'BANK_TRANSFER'|'OTHER'; destination: string }) {
  const currency = normalizeCurrency(input.currency);
  if (input.amount < env.WALLET_MIN_WITHDRAWAL_AMOUNT) throw badRequest('WITHDRAWAL_BELOW_MINIMUM', `Montant minimum de retrait : ${env.WALLET_MIN_WITHDRAWAL_AMOUNT}`);
  const fee = Math.floor((input.amount * env.WALLET_WITHDRAWAL_FEE_BPS) / 10_000);
  const total = input.amount;
  return db.$transaction(async tx => {
    const wallet = await ensureWallet(tx, user.id, currency);
    if (wallet.availableAmount < total) throw conflict('INSUFFICIENT_AVAILABLE_BALANCE', 'Solde disponible insuffisant', { availableAmount: wallet.availableAmount, requiredAmount: total, currency });
    const w = await tx.wallet.update({ where: { id: wallet.id }, data: { availableAmount: { decrement: total }, blockedAmount: { increment: total } } });
    const withdrawal = await tx.withdrawal.create({ data: { userId: user.id, currency, amount: input.amount, fee, netAmount: input.amount - fee, method: input.method, destinationHint: input.destination, status: 'PENDING' } });
    await tx.walletLedgerEntry.create({ data: { walletId: wallet.id, userId: user.id, type: 'WITHDRAWAL_HOLD', amount: -total, balanceAfter: w.availableAmount, currency, sourceType: 'WITHDRAWAL', sourceId: withdrawal.id, description: 'Réservation du solde pour retrait' } });
    await tx.financialTransaction.create({ data: { reference: `W-${withdrawal.id}`, type: 'WITHDRAWAL', status: 'PENDING', userId: user.id, grossAmount: input.amount, platformFeeAmount: fee, creatorAmount: input.amount - fee, currency, method: input.method, sourceType: 'WITHDRAWAL', sourceId: withdrawal.id } });
    return { withdrawal, wallet: w };
  });
}

/** Crée/actualise la transaction financière correspondant à une tentative de paiement existante. */
export async function syncPaymentTransaction(reference: string, status: 'PAID'|'FAILED'|'REVIEW', externalReference?: string) {
  return db.$transaction(async tx => {
    let sourceType = 'PAID_MESSAGE'; let sourceId = ''; let userId = ''; let creatorId: string | null = null; let grossAmount = 0; let fee = 0; let creatorAmount = 0; let method: 'MOBILE_MONEY' = 'MOBILE_MONEY'; let currency = 'XAF';
    if (reference.startsWith('C')) {
      const p = await tx.call.findUnique({ where: { reference }, select: { id:true, callerId:true, calleeId:true, currency:true, grossAmount:true, commissionAmount:true, creatorAmount:true, paymentStatus:true, operator:true, externalRef:true } });
      if (!p) return null; sourceType='PAID_CALL'; currency=p.currency; sourceId=p.id; userId=p.callerId; creatorId=p.calleeId; grossAmount=p.grossAmount; fee=p.commissionAmount ?? Math.max(0, p.grossAmount-p.creatorAmount!); creatorAmount=p.creatorAmount ?? 0; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else if (reference.startsWith('S')) {
      const p = await tx.creatorSubscriptionPayment.findUnique({ where: { reference }, select: { id:true,buyerId:true,creatorId:true,currency:true,grossAmount:true,commissionAmount:true,creatorAmount:true,externalRef:true } });
      if (!p) return null; sourceType='CREATOR_SUBSCRIPTION'; currency=p.currency; sourceId=p.id; userId=p.buyerId; creatorId=p.creatorId; grossAmount=p.grossAmount; fee=p.commissionAmount; creatorAmount=p.creatorAmount; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else if (reference.startsWith('P')) {
      const p = await tx.premiumPayment.findUnique({ where: { reference }, select: { id:true,userId:true,grossAmount:true,discountAmount:true,netAmount:true,currency:true,externalRef:true } });
      if (!p) return null; sourceType='PREMIUM'; sourceId=p.id; userId=p.userId; creatorId=null; grossAmount=p.netAmount; fee=0; creatorAmount=0; currency='XAF'; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else if (reference.startsWith('K')) {
      const p = await tx.coinPurchase.findUnique({ where: { reference }, select: { id:true,userId:true,grossAmount:true,currency:true,externalRef:true } });
      if (!p) return null; sourceType='COIN_PURCHASE'; sourceId=p.id; userId=p.userId; creatorId=null; grossAmount=p.grossAmount; fee=0; creatorAmount=0; currency=p.currency; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else if (reference.startsWith('V')) {
      const p = await tx.customVideoPayment.findUnique({ where: { reference }, select: { id:true,buyerId:true,creatorId:true,currency:true,grossAmount:true,commissionAmount:true,creatorAmount:true,externalRef:true } });
      if (!p) return null; sourceType='CUSTOM_VIDEO'; sourceId=p.id; userId=p.buyerId; creatorId=p.creatorId; grossAmount=p.grossAmount; fee=p.commissionAmount; creatorAmount=p.creatorAmount; currency=p.currency; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else if (reference.startsWith('G')) {
      const p = await tx.groupAccessPurchase.findUnique({ where: { reference }, select: { id:true,buyerId:true,sellerId:true,currency:true,grossAmount:true,commissionAmount:true,creatorAmount:true,externalRef:true } });
      if (!p) return null; sourceType='GROUP_ACCESS'; currency=p.currency; sourceId=p.id; userId=p.buyerId; creatorId=p.sellerId; grossAmount=p.grossAmount; fee=p.commissionAmount; creatorAmount=p.creatorAmount; externalReference=externalReference ?? p.externalRef ?? undefined;
    } else {
      const p = await tx.messagePurchase.findUnique({ where: { reference }, select: { id:true,buyerId:true,sellerId:true,currency:true,grossAmount:true,commissionAmount:true,creatorAmount:true,externalRef:true } });
      if (!p) return null; sourceType='PAID_MESSAGE'; currency=p.currency; sourceId=p.id; userId=p.buyerId; creatorId=p.sellerId; grossAmount=p.grossAmount; fee=p.commissionAmount; creatorAmount=p.creatorAmount; externalReference=externalReference ?? p.externalRef ?? undefined;
    }
    const row = await tx.financialTransaction.upsert({
      where: { sourceType_sourceId: { sourceType, sourceId } },
      create: { reference, type:'PAYMENT', status, userId, creatorId, grossAmount, platformFeeAmount:fee, creatorAmount, currency, method, externalReference, sourceType, sourceId, paidAt: status==='PAID'?new Date():null },
      update: { status, externalReference, paidAt: status==='PAID'?new Date():undefined },
    });
    return row;
  });
}
