import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { splitAmount } from '../../utils/money';
import { forbidden } from '../../utils/errors';
import { DEFAULT_CURRENCY, listCurrencies, normalizeCurrency } from './currency';
import { creditCreatorWallet } from '../wallet/wallet.service';
import { getCurrentRuleVersion } from '../config/config.service';

const commissionBps = () => env.PAID_MESSAGE_COMMISSION_BPS ?? 2000;

export type EarningRecordInput = {
  creatorId: string;
  source: 'PAID_MESSAGE' | 'PAID_CALL' | 'VIDEO' | 'SHORT' | 'LIVE' | 'CREATOR_SUBSCRIPTION' | 'PAID_CONTENT' | 'CUSTOM_VIDEO' | 'GIFT' | 'TIP' | 'CREATOR_POOL' | 'OTHER';
  sourceId: string;
  grossAmount: number;
  currency: string;
  commissionBps?: number;
  status?: 'PENDING' | 'AVAILABLE' | 'REVERSED';
  ruleVersion?: string;
};

/** Écriture idempotente : une source financière ne peut produire qu'un revenu créateur. */
export async function recordCreatorEarning(db: Prisma.TransactionClient | typeof prisma, input: EarningRecordInput) {
  const creator = await db.user.findUnique({ where: { id: input.creatorId }, select: { id: true, status: true, monetizationDisabledAt: true } });
  if (!creator) throw forbidden('CREATOR_NOT_FOUND', 'Créateur introuvable');
  if (creator.status !== 'ACTIVE' || creator.monetizationDisabledAt) throw forbidden('MONETIZATION_DISABLED', 'La monétisation de ce créateur est désactivée');
  const currency = normalizeCurrency(input.currency);
  const split = splitAmount(input.grossAmount, input.commissionBps ?? commissionBps());
  const ruleVersion = input.ruleVersion ?? await getCurrentRuleVersion(db);
  const status = input.status ?? 'AVAILABLE';
  const earning = await db.creatorEarning.upsert({
    where: { source_sourceId: { source: input.source, sourceId: input.sourceId } },
    create: {
      creatorId: input.creatorId,
      source: input.source,
      sourceId: input.sourceId,
      grossAmount: split.grossAmount,
      platformFeeAmount: split.platformFeeAmount,
      creatorAmount: split.creatorAmount,
      currency,
      commissionBps: split.commissionBps,
      status,
      ruleVersion,
      availableAt: status === 'AVAILABLE' ? new Date() : null,
    },
    update: {},
  });
  if (earning.creatorAmount > 0) await creditCreatorWallet(db, { creatorId: earning.creatorId, sourceType: 'CREATOR_EARNING', sourceId: earning.id, amount: earning.creatorAmount, currency: earning.currency, pending: earning.status === 'PENDING', description: `Revenu ${earning.source}` });
  return earning;
}

export async function recordPaidMessageEarning(db: Prisma.TransactionClient | typeof prisma, purchase: { id: string; sellerId: string; grossFcfa: number; commissionBps: number }) {
  return recordCreatorEarning(db, {
    creatorId: purchase.sellerId,
    source: 'PAID_MESSAGE',
    sourceId: purchase.id,
    grossAmount: purchase.grossFcfa,
    currency: DEFAULT_CURRENCY,
    commissionBps: purchase.commissionBps,
    status: 'AVAILABLE',
  });
}

export async function recordPaidCallEarning(db: Prisma.TransactionClient | typeof prisma, call: { id: string; calleeId: string; consumedFcfa: number; commissionFcfa: number; creatorFcfa: number; commissionBps: number }) {
  const ruleVersion = await getCurrentRuleVersion(db);
  const earning = await db.creatorEarning.upsert({
    where: { source_sourceId: { source: 'PAID_CALL', sourceId: call.id } },
    create: {
      creatorId: call.calleeId,
      source: 'PAID_CALL',
      sourceId: call.id,
      grossAmount: call.consumedFcfa,
      platformFeeAmount: call.commissionFcfa,
      creatorAmount: call.creatorFcfa,
      currency: DEFAULT_CURRENCY,
      commissionBps: call.commissionBps,
      status: 'AVAILABLE',
      ruleVersion,
      availableAt: new Date(),
    },
    update: {},
  });
  await creditCreatorWallet(db, { creatorId: earning.creatorId, sourceType: 'CREATOR_EARNING', sourceId: earning.id, amount: earning.creatorAmount, currency: earning.currency, description: 'Revenu PAID_CALL' });
  if (earning.creatorAmount > 0) {
    await db.financialTransaction.updateMany({ where: { sourceType: 'PAID_CALL', sourceId: call.id }, data: { creatorAmount: earning.creatorAmount, platformFeeAmount: call.commissionFcfa, grossAmount: call.consumedFcfa, status: 'COMPLETED', completedAt: new Date() } });
  }
  return earning;
}

export async function getCreatorEarnings(viewer: User, currency?: string) {
  if (!viewer.isCreator) return { balances: [], totalEarnings: 0 };
  const where = { creatorId: viewer.id, ...(currency ? { currency: normalizeCurrency(currency) } : {}) };
  const groups = await prisma.creatorEarning.groupBy({ by: ['currency', 'status'], where, _sum: { creatorAmount: true } });
  const byCurrency = new Map<string, { currency: string; available: number; pending: number; reversed: number; total: number }>();
  for (const row of groups) {
    const b = byCurrency.get(row.currency) ?? { currency: row.currency, available: 0, pending: 0, reversed: 0, total: 0 };
    const amount = row._sum.creatorAmount ?? 0;
    if (row.status === 'AVAILABLE') b.available += amount;
    if (row.status === 'PENDING') b.pending += amount;
    if (row.status === 'REVERSED') b.reversed += amount;
    if (row.status !== 'REVERSED') b.total += amount;
    byCurrency.set(row.currency, b);
  }
  return { balances: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)), totalEarnings: [...byCurrency.values()].reduce((n, x) => n + x.total, 0) };
}

export async function getCreatorBreakdown(viewer: User, currency?: string) {
  if (!viewer.isCreator) return { items: [] };
  const where = { creatorId: viewer.id, ...(currency ? { currency: normalizeCurrency(currency) } : {}) };
  const groups = await prisma.creatorEarning.groupBy({ by: ['source', 'currency', 'status'], where, _sum: { grossAmount: true, platformFeeAmount: true, creatorAmount: true }, _count: { _all: true } });
  return { items: groups.map((x) => ({ source: x.source, currency: x.currency, status: x.status, count: x._count._all, grossAmount: x._sum.grossAmount ?? 0, platformFeeAmount: x._sum.platformFeeAmount ?? 0, creatorAmount: x._sum.creatorAmount ?? 0 })) };
}

export async function publicMonetizationSettings() {
  const { getViewMonetizationSettings } = await import('./views.service.js');
  const viewSettings = await getViewMonetizationSettings();
  return { defaultLanguage: 'fr', supportedLanguages: ['fr', 'en'], defaultCurrency: DEFAULT_CURRENCY, currencies: listCurrencies(), directCommissionBps: commissionBps(), viewMonetization: viewSettings };
}
