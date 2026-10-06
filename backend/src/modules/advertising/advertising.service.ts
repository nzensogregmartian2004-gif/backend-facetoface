import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { normalizeCurrency } from '../monetization/currency';
import { getViewMonetizationSettings, splitAdvertisingRevenue } from '../monetization/views.service';
import { hasActivePremium } from '../premium/premium.service';
import { assessActivity } from '../fraud/fraud.service';

type DB = Prisma.TransactionClient | typeof prisma;

async function settings(db: DB) {
  return db.advertisingSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', defaultFrequencyCap: env.ADVERTISING_DEFAULT_FREQUENCY_CAP, defaultFrequencyWindowHours: env.ADVERTISING_DEFAULT_FREQUENCY_WINDOW_HOURS, creatorShareBps: env.ADVERTISING_CREATOR_SHARE_BPS },
    update: {},
  });
}

function eligibleCampaign(row: any, user: User, format: string, placement: string, category?: string) {
  if (!row.formats.includes(format) || !row.placements.includes(placement)) return false;
  if (row.targetLanguages.length && !row.targetLanguages.includes(user.preferredLanguage)) return false;
  if (row.targetCountries.length && (!user.country || !row.targetCountries.includes(user.country.toUpperCase()))) return false;
  if (row.targetCategories.length && (!category || !row.targetCategories.includes(category))) return false;
  return true;
}

export async function getSettings() {
  return settings(prisma);
}

export async function updateSettings(input: { enabled?: boolean; defaultFrequencyCap?: number; defaultFrequencyWindowHours?: number; creatorShareBps?: number }, userId: string) {
  return prisma.advertisingSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...input, updatedByUserId: userId },
    update: { ...input, updatedByUserId: userId },
  });
}

export async function createCampaign(userId: string, input: any) {
  const currency = normalizeCurrency(input.currency);
  return prisma.advertisingCampaign.create({ data: { ...input, currency, createdById: userId } });
}

export async function listCampaigns(status?: string) {
  return prisma.advertisingCampaign.findMany({ where: status ? { status: status as any } : undefined, orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function setCampaignStatus(id: string, status: 'DRAFT'|'ACTIVE'|'PAUSED'|'COMPLETED'|'ARCHIVED') {
  const row = await prisma.advertisingCampaign.findUnique({ where: { id } });
  if (!row) throw notFound('Campagne publicitaire introuvable');
  if (status === 'ACTIVE' && row.budgetAmount <= row.spentAmount) throw conflict('CAMPAIGN_BUDGET_EXHAUSTED', 'Le budget de cette campagne est épuisé');
  return prisma.advertisingCampaign.update({ where: { id }, data: { status, activatedAt: status === 'ACTIVE' ? (row.activatedAt ?? new Date()) : row.activatedAt } });
}

export async function selectAd(user: User, input: { format: string; placement: string; category?: string; contentType?: string; contentId?: string; creatorId?: string }) {
  const cfg = await settings(prisma);
  if (!cfg.enabled || await hasActivePremium(user.id)) return null;
  const now = new Date();
  const rows = await prisma.advertisingCampaign.findMany({
    where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now }, currency: normalizeCurrency(user.preferredCurrency) },
    orderBy: [{ spentAmount: 'asc' }, { createdAt: 'asc' }], take: 50,
  });
  for (const row of rows) {
    if (!eligibleCampaign(row, user, input.format, input.placement, input.category)) continue;
    if (row.spentAmount + row.pricePerImpression > row.budgetAmount) continue;
    const cap = row.frequencyCap ?? cfg.defaultFrequencyCap;
    const windowHours = row.frequencyWindowHours ?? cfg.defaultFrequencyWindowHours;
    const since = new Date(Date.now() - windowHours * 3600_000);
    const count = await prisma.adImpression.count({ where: { campaignId: row.id, userId: user.id, createdAt: { gte: since } } });
    if (count >= cap) continue;
    return { campaignId: row.id, format: input.format, placement: input.placement, headline: row.headline, body: row.body, mediaUrl: row.mediaUrl, clickUrl: row.clickUrl, currency: row.currency, pricePerImpression: row.pricePerImpression, frequencyCap: cap, frequencyWindowHours: windowHours, contentType: input.contentType ?? null, contentId: input.contentId ?? null, creatorId: input.creatorId ?? null };
  }
  return null;
}

export async function recordImpression(user: User, campaignId: string, input: { eventKey: string; format: string; placement: string; contentType?: string; contentId?: string; creatorId?: string; category?: string }, context: { ip?: string; userAgent?: string } = {}) {
  const risk = await assessActivity(user.id, 'AD_IMPRESSION', context);
  if (risk.decision !== 'ALLOW') throw conflict('AD_FRAUD_REVIEW', 'Cette impression publicitaire a été exclue par le contrôle anti-fraude');
  const existing = await prisma.adImpression.findUnique({ where: { eventKey: input.eventKey } });
  if (existing) return { impression: existing, duplicate: true };
  const cfg = await settings(prisma);
  if (!cfg.enabled) throw conflict('ADVERTISING_DISABLED', 'La publicité est désactivée');
  return prisma.$transaction(async tx => {
    const campaign = await tx.advertisingCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw notFound('Campagne publicitaire introuvable');
    const now = new Date();
    if (campaign.status !== 'ACTIVE' || campaign.startsAt > now || campaign.endsAt <= now) throw conflict('CAMPAIGN_NOT_ACTIVE', 'Cette campagne n’est plus active');
    if (!campaign.formats.includes(input.format as any) || !campaign.placements.includes(input.placement as any)) throw badRequest('AD_TARGET_MISMATCH', 'Format ou emplacement non autorisé par la campagne');
    if (campaign.spentAmount + campaign.pricePerImpression > campaign.budgetAmount) throw conflict('CAMPAIGN_BUDGET_EXHAUSTED', 'Le budget publicitaire est épuisé');
    const cap = campaign.frequencyCap ?? cfg.defaultFrequencyCap;
    const windowHours = campaign.frequencyWindowHours ?? cfg.defaultFrequencyWindowHours;
    const count = await tx.adImpression.count({ where: { campaignId, userId: user.id, createdAt: { gte: new Date(Date.now() - windowHours * 3600_000) } } });
    if (count >= cap) throw conflict('AD_FREQUENCY_CAP', 'La fréquence maximale de cette campagne est atteinte');

    const split = splitAdvertisingRevenue(campaign.pricePerImpression, cfg.creatorShareBps);
    const revenue = await tx.advertisingRevenue.create({ data: { externalReference: `ADIMP-${input.eventKey}`, currency: campaign.currency, grossAmount: campaign.pricePerImpression, platformShareBps: split.platformShareBps, creatorPoolShareBps: split.creatorPoolShareBps, creatorPoolAmount: split.creatorPoolAmount, receivedAt: now } });
    const impression = await tx.adImpression.create({ data: { campaignId, userId: user.id, creatorId: input.creatorId, format: input.format as any, placement: input.placement as any, contentType: input.contentType, contentId: input.contentId, category: input.category, eventKey: input.eventKey, chargedAmount: campaign.pricePerImpression, creatorPoolAmount: split.creatorPoolAmount, platformAmount: split.platformAmount, currency: campaign.currency, advertisingRevenueId: revenue.id } });
    const nextSpent = campaign.spentAmount + campaign.pricePerImpression;
    await tx.advertisingCampaign.update({ where: { id: campaignId }, data: { spentAmount: { increment: campaign.pricePerImpression }, ...(nextSpent >= campaign.budgetAmount ? { status: 'COMPLETED' } : {}) } });
    return { impression, duplicate: false };
  });
}

export async function recordClick(user: User, impressionId: string, context: { ip?: string; userAgent?: string } = {}) {
  const risk = await assessActivity(user.id, 'AD_CLICK', context);
  if (risk.decision !== 'ALLOW') throw conflict('AD_CLICK_FRAUD_REVIEW', 'Ce clic publicitaire a été exclu par le contrôle anti-fraude');
  const impression = await prisma.adImpression.findUnique({ where: { id: impressionId } });
  if (!impression || (impression.userId && impression.userId !== user.id)) throw notFound('Impression publicitaire introuvable');
  const click = await prisma.adClick.findUnique({ where: { impressionId } });
  if (click) return click;
  return prisma.adClick.create({ data: { impressionId, userId: user.id } });
}

export async function report(currency?: string) {
  const where = currency ? { currency: normalizeCurrency(currency) } : {};
  const [campaigns, revenue, impressions, clicks] = await Promise.all([
    prisma.advertisingCampaign.count(),
    prisma.advertisingRevenue.aggregate({ where, _sum: { grossAmount: true, creatorPoolAmount: true } }),
    prisma.adImpression.count({ where: currency ? { currency: normalizeCurrency(currency) } : undefined }),
    prisma.adClick.count(),
  ]);
  return { campaigns, impressions, clicks, grossRevenue: revenue._sum.grossAmount ?? 0, creatorPoolRevenue: revenue._sum.creatorPoolAmount ?? 0 };
}
