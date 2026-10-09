import { createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { conflict } from '../../utils/errors';

type ActivityType = 'VIEW' | 'AD_IMPRESSION' | 'AD_CLICK' | 'PAYMENT';
type Decision = 'ALLOW' | 'REVIEW' | 'BLOCK';

const BOT_RE = /(bot|crawler|spider|headless|selenium|playwright|puppeteer|phantomjs|curl\/|wget\/)/i;
const HASH_KEY = process.env.JWT_SECRET || 'face-to-face-fraud-hash';
const WINDOW_HOUR = 60 * 60 * 1000;
const WINDOW_DAY = 24 * WINDOW_HOUR;

const hash = (value: string) => createHmac('sha256', HASH_KEY).update(value).digest('hex');
const uaHash = (value?: string) => value ? hash(value.slice(0, 512)) : undefined;
const ipHash = (value?: string) => value ? hash(value) : undefined;

export type FraudContext = { ip?: string; userAgent?: string; metadata?: Record<string, unknown> };

export async function assessActivity(userId: string, type: ActivityType, context: FraudContext = {}, extra: { watchedSeconds?: number; contentDurationSeconds?: number | null } = {}) {
  const now = new Date();
  const sinceHour = new Date(now.getTime() - WINDOW_HOUR);
  const ip = ipHash(context.ip);
  const bot = !!context.userAgent && BOT_RE.test(context.userAgent);
  const [user, userEvents, ipEvents] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, fraudStatus: true } }),
    prisma.fraudEvent.count({ where: { userId, type, createdAt: { gte: sinceHour } } }),
    ip ? prisma.fraudEvent.count({ where: { ipHash: ip, type, createdAt: { gte: sinceHour } } }) : Promise.resolve(0),
  ]);
  if (!user) return { decision: 'BLOCK' as const, score: 100, reason: 'USER_NOT_FOUND' };

  let score = 0;
  const reasons: string[] = [];
  if (user.fraudStatus === 'BLOCKED') { score += 100; reasons.push('ACCOUNT_BLOCKED'); }
  else if (user.fraudStatus === 'REVIEW') { score += 60; reasons.push('ACCOUNT_REVIEW'); }
  if (bot) { score += 100; reasons.push('AUTOMATED_CLIENT'); }
  if (userEvents >= (type === 'VIEW' ? 90 : type === 'AD_CLICK' ? 20 : type === 'PAYMENT' ? 8 : 60)) { score += 55; reasons.push('HIGH_ACTIVITY_RATE'); }
  if (ipEvents >= (type === 'VIEW' ? 180 : 100)) { score += 45; reasons.push('HIGH_IP_ACTIVITY'); }
  if (user.createdAt.getTime() > now.getTime() - WINDOW_DAY && type === 'VIEW' && userEvents >= 20) { score += 35; reasons.push('NEW_ACCOUNT_VIEW_SPIKE'); }
  if (extra.contentDurationSeconds != null && extra.watchedSeconds != null && extra.watchedSeconds > Math.max(extra.contentDurationSeconds * 2, extra.contentDurationSeconds + 30)) { score += 70; reasons.push('IMPOSSIBLE_WATCH_TIME'); }
  if (type === 'AD_CLICK' && userEvents >= 10) { score += 45; reasons.push('CLICK_VELOCITY'); }
  if (type === 'PAYMENT' && user.createdAt.getTime() > now.getTime() - WINDOW_DAY && userEvents >= 2) { score += 40; reasons.push('NEW_ACCOUNT_PAYMENT_SPIKE'); }

  const decision: Decision = score >= 100 ? 'BLOCK' : score >= 50 ? 'REVIEW' : 'ALLOW';
  const reason = reasons.join(',') || 'NORMAL_ACTIVITY';
  await prisma.$transaction(async tx => {
    await tx.fraudEvent.create({ data: { userId, type, decision, score, reason, ipHash: ip, userAgentHash: uaHash(context.userAgent), metadata: context.metadata as Prisma.InputJsonValue | undefined } });
    if (decision !== 'ALLOW') {
      await tx.user.update({ where: { id: userId }, data: { fraudStatus: decision === 'BLOCK' ? 'BLOCKED' : 'REVIEW', fraudScore: score, fraudFlaggedAt: now } });
    } else if (user.fraudStatus === 'REVIEW') {
      await tx.user.update({ where: { id: userId }, data: { fraudScore: Math.max(0, score) } });
    }
  });
  return { decision, score, reason };
}

export async function assertPaymentAllowed(userId: string, context: FraudContext = {}) {
  const result = await assessActivity(userId, 'PAYMENT', context);
  if (result.decision !== 'ALLOW') throw conflict('PAYMENT_FRAUD_REVIEW', 'Cette transaction est soumise à une vérification anti-fraude');
  return result;
}

export async function holdPaymentReference(reference: string, reason = 'FRAUD_RISK') {
  return prisma.$transaction(async tx => {
    let userId: string | null = null;
    if (reference.startsWith('C')) {
      const row = await tx.call.findUnique({ where: { reference }, select: { id: true, callerId: true, paymentStatus: true } });
      if (!row) return false; userId = row.callerId;
      if (row.paymentStatus === 'PENDING' || row.paymentStatus === 'REVIEW') await tx.call.update({ where: { id: row.id }, data: { paymentStatus: 'REVIEW', reviewReason: reason } });
    } else if (reference.startsWith('S')) {
      const row = await tx.creatorSubscriptionPayment.findUnique({ where: { reference }, select: { id: true, buyerId: true, status: true } });
      if (!row) return false; userId = row.buyerId;
      if (row.status === 'PENDING' || row.status === 'REVIEW') await tx.creatorSubscriptionPayment.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewReason: reason } });
    } else if (reference.startsWith('VC')) {
      const row = await tx.paidContentPurchase.findUnique({ where: { reference }, select: { id: true, buyerId: true, status: true } });
      if (!row) return false; userId = row.buyerId;
      if (row.status === 'PENDING' || row.status === 'REVIEW') await tx.paidContentPurchase.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewReason: reason } });
    } else if (reference.startsWith('V')) {
      const row = await tx.customVideoPayment.findUnique({ where: { reference }, select: { id: true, buyerId: true, status: true } });
      if (!row) return false; userId = row.buyerId;
      if (row.status === 'PENDING' || row.status === 'REVIEW') await tx.customVideoPayment.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewReason: reason } });
    } else if (reference.startsWith('P')) {
      const row = await tx.premiumPayment.findUnique({ where: { reference }, select: { id: true, userId: true, status: true } });
      if (!row) return false; userId = row.userId;
      if (row.status === 'PENDING' || row.status === 'REVIEW') await tx.premiumPayment.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewReason: reason } });
    } else {
      const row = await tx.messagePurchase.findUnique({ where: { reference }, select: { id: true, buyerId: true, status: true } });
      if (!row) return false; userId = row.buyerId;
      if (row.status === 'PENDING' || row.status === 'REVIEW') await tx.messagePurchase.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewReason: reason } });
    }
    await tx.fraudEvent.create({ data: { userId, type: 'PAYMENT', decision: 'REVIEW', score: 80, reason } });
    return true;
  });
}

export async function listEvents(input: { userId?: string; decision?: Decision; limit?: number }) {
  return prisma.fraudEvent.findMany({ where: { ...(input.userId ? { userId: input.userId } : {}), ...(input.decision ? { decision: input.decision } : {}) }, orderBy: { createdAt: 'desc' }, take: input.limit ?? 100 });
}
