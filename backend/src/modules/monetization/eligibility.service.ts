import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { notFound } from '../../utils/errors';

export const DEFAULT_MONETIZATION_CONDITIONS: Record<string, number> = {
  MIN_SUBSCRIBERS: 500,
  MIN_WATCH_TIME_SECONDS: 3_000 * 60 * 60,
  WATCH_TIME_PERIOD_DAYS: 365,
  MIN_SHORT_VIEWS: 3_000_000,
  SHORTS_PERIOD_DAYS: 90,
  MIN_PUBLICATIONS: 3,
  PUBLICATIONS_PERIOD_DAYS: 90,
  REQUIRE_VERIFIED_ACCOUNT: 1,
  REQUIRE_NO_ACTIVE_SANCTION: 1,
  REQUIRE_ORIGINAL_CONTENT: 1,
  EXCLUDE_ARTIFICIAL_VIEWS: 1,
  EXCLUDE_REMOVED_CONTENT: 1,
  EXCLUDE_PRIVATE_CONTENT: 1,
  MIN_PAYOUT_AGE: 18,
  REQUIRE_MANUAL_VALIDATION: 1,
  VIDEO_MIN_DURATION_SECONDS: 0,
  VIDEO_MIN_WATCHED_SECONDS: 0,
  VIDEO_MIN_WATCH_PERCENT_BPS: 0,
  SHORT_MIN_DURATION_SECONDS: 0,
  SHORT_MIN_WATCHED_SECONDS: 0,
  SHORT_MIN_WATCH_PERCENT_BPS: 0,
  LIVE_MIN_DURATION_SECONDS: 0,
  LIVE_MIN_VIEWERS: 0,
  LIVE_MIN_UNIQUE_VIEWERS: 0,
  LIVE_MIN_WATCH_TIME_SECONDS: 0,
  LIVE_MIN_ENGAGEMENT_BPS: 0,
};

const DESCRIPTIONS: Record<string, string> = {
  MIN_SUBSCRIBERS: 'Nombre minimum d’abonnés pour la monétisation.',
  MIN_WATCH_TIME_SECONDS: 'Temps de visionnage minimum des vidéos longues sur la période.',
  WATCH_TIME_PERIOD_DAYS: 'Période glissante utilisée pour les heures de visionnage.',
  MIN_SHORT_VIEWS: 'Nombre minimum de vues Shorts sur la période.',
  SHORTS_PERIOD_DAYS: 'Période glissante utilisée pour les vues Shorts.',
  MIN_PUBLICATIONS: 'Nombre minimum de publications sur la période.',
  PUBLICATIONS_PERIOD_DAYS: 'Période glissante utilisée pour les publications.',
  REQUIRE_VERIFIED_ACCOUNT: 'Compte vérifié obligatoire.',
  REQUIRE_NO_ACTIVE_SANCTION: 'Aucune sanction active obligatoire.',
  REQUIRE_ORIGINAL_CONTENT: 'Contenu original obligatoire.',
  EXCLUDE_ARTIFICIAL_VIEWS: 'Les vues artificielles sont exclues.',
  EXCLUDE_REMOVED_CONTENT: 'Les contenus supprimés sont exclus.',
  EXCLUDE_PRIVATE_CONTENT: 'Les contenus privés sont exclus.',
  MIN_PAYOUT_AGE: 'Âge minimum pour le paiement.',
  REQUIRE_MANUAL_VALIDATION: 'Validation manuelle obligatoire.',
  VIDEO_MIN_DURATION_SECONDS: 'Durée minimale des vidéos longues.',
  VIDEO_MIN_WATCHED_SECONDS: 'Durée minimale regardée pour une vue qualifiée vidéo.',
  VIDEO_MIN_WATCH_PERCENT_BPS: 'Pourcentage minimal regardé pour une vue qualifiée vidéo, en points de base.',
  SHORT_MIN_DURATION_SECONDS: 'Durée minimale des Shorts.',
  SHORT_MIN_WATCHED_SECONDS: 'Durée minimale regardée pour une vue qualifiée Short.',
  SHORT_MIN_WATCH_PERCENT_BPS: 'Pourcentage minimal regardé pour une vue qualifiée Short, en points de base.',
  LIVE_MIN_DURATION_SECONDS: 'Durée minimale d’un Live pour la monétisation.',
  LIVE_MIN_VIEWERS: 'Nombre minimum de spectateurs d’un Live.',
  LIVE_MIN_UNIQUE_VIEWERS: 'Nombre minimum de spectateurs uniques d’un Live.',
  LIVE_MIN_WATCH_TIME_SECONDS: 'Temps de visionnage minimum d’un Live.',
  LIVE_MIN_ENGAGEMENT_BPS: 'Engagement minimum d’un Live, en points de base.',
};

async function setting(db: Prisma.TransactionClient | typeof prisma, key: string) {
  const fallback = DEFAULT_MONETIZATION_CONDITIONS[key];
  if (fallback === undefined) throw new Error(`Paramètre de monétisation inconnu: ${key}`);
  return db.viewMonetizationSetting.upsert({
    where: { key },
    create: { key, value: fallback, description: DESCRIPTIONS[key] },
    update: {},
  });
}

export async function getMonetizationConditions(db: Prisma.TransactionClient | typeof prisma = prisma) {
  const rows = await Promise.all(Object.keys(DEFAULT_MONETIZATION_CONDITIONS).map((key) => setting(db, key)));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setMonetizationCondition(key: keyof typeof DEFAULT_MONETIZATION_CONDITIONS, value: number, adminId: string, reason: string) {
  if (!(key in DEFAULT_MONETIZATION_CONDITIONS) || !Number.isSafeInteger(value) || value < 0) throw new Error('Paramètre de monétisation invalide');
  if (!reason.trim()) throw new Error('Une raison est obligatoire');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.viewMonetizationSetting.findUnique({ where: { key } });
    const setting = await tx.viewMonetizationSetting.upsert({ where: { key }, create: { key, value, description: DESCRIPTIONS[key] }, update: { value } });
    if (!existing || existing.value !== value) {
      const rows = await tx.$queryRawUnsafe<Array<{ version: number }>>(`SELECT nextval('monetization_setting_version_seq')::int AS version`);
      await tx.monetizationSettingVersion.create({ data: { version: rows[0].version, settingKey: key, oldValue: existing ? existing.value : undefined, newValue: value, adminId, reason: reason.trim(), viewSettingId: setting.id } });
    }
    return setting;
  });
}

function ageAt(birthDate: Date, now: Date) {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const m = now.getUTCMonth() - birthDate.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age;
}

export async function evaluateCreatorEligibility(creatorId: string, now = new Date()) {
  const c = await getMonetizationConditions();
  const user = await prisma.user.findUnique({ where: { id: creatorId }, select: { id: true, isCreator: true, status: true, emailVerifiedAt: true, birthDate: true, monetizationDisabledAt: true } });
  if (!user) return { eligible: false, reasons: ['CREATOR_NOT_FOUND'], checks: {} };
  const periodStart = new Date(now.getTime() - c.WATCH_TIME_PERIOD_DAYS * 86_400_000);
  const shortsStart = new Date(now.getTime() - c.SHORTS_PERIOD_DAYS * 86_400_000);
  const publicationStart = new Date(now.getTime() - c.PUBLICATIONS_PERIOD_DAYS * 86_400_000);
  const [followers, views, shortViews, videoPublications, shortPublications, approval] = await Promise.all([
    prisma.follow.count({ where: { followingId: creatorId } }),
    prisma.contentView.findMany({ where: { createdAt: { gte: periodStart }, targetType: 'VIDEO', targetId: { not: '' }, userId: { not: creatorId } }, select: { targetId: true, watchedSeconds: true } }),
    prisma.contentView.findMany({ where: { createdAt: { gte: shortsStart }, targetType: 'SHORT', userId: { not: creatorId } }, select: { targetId: true, watchedSeconds: true } }),
    prisma.video.count({ where: { authorId: creatorId, status: 'PUBLISHED', visibility: { not: 'PRIVATE' }, deletedAt: null, publishedAt: { gte: publicationStart } } }),
    prisma.short.count({ where: { authorId: creatorId, status: 'PUBLISHED', visibility: { not: 'PRIVATE' }, deletedAt: null, isOriginal: true, publishedAt: { gte: publicationStart } } }),
    prisma.creatorMonetizationEligibility.findUnique({ where: { creatorId } }),
  ]);
  const videoIds = [...new Set(views.map(v => v.targetId))];
  const shortIds = [...new Set(shortViews.map(v => v.targetId))];
  const [videoRows, shortRows] = await Promise.all([
    prisma.video.findMany({ where: { id: { in: videoIds }, authorId: creatorId, status: 'PUBLISHED', visibility: { not: 'PRIVATE' }, deletedAt: null, isOriginal: true }, select: { id: true, durationSeconds: true } }),
    prisma.short.findMany({ where: { id: { in: shortIds }, authorId: creatorId, status: 'PUBLISHED', visibility: { not: 'PRIVATE' }, deletedAt: null, isOriginal: true }, select: { id: true, durationSeconds: true } }),
  ]);
  const videoById = new Map(videoRows.map(v => [v.id, v.durationSeconds]));
  const shortById = new Map(shortRows.map(v => [v.id, v.durationSeconds]));
  const watchedSeconds = views.reduce((n, v) => {
    const duration = videoById.get(v.targetId);
    if (duration === undefined || duration === null || duration < c.VIDEO_MIN_DURATION_SECONDS || v.watchedSeconds < c.VIDEO_MIN_WATCHED_SECONDS) return n;
    if (c.VIDEO_MIN_WATCH_PERCENT_BPS > 0 && v.watchedSeconds * 10_000 < duration * c.VIDEO_MIN_WATCH_PERCENT_BPS) return n;
    return n + v.watchedSeconds;
  }, 0);
  const qualifiedShortViews = shortViews.reduce((n, v) => {
    const duration = shortById.get(v.targetId);
    if (duration === undefined || duration === null || duration < c.SHORT_MIN_DURATION_SECONDS || v.watchedSeconds < c.SHORT_MIN_WATCHED_SECONDS) return n;
    if (c.SHORT_MIN_WATCH_PERCENT_BPS > 0 && v.watchedSeconds * 10_000 < duration * c.SHORT_MIN_WATCH_PERCENT_BPS) return n;
    return n + 1;
  }, 0);
  const checks = {
    creatorAccount: user.isCreator && !user.monetizationDisabledAt,
    monetizationEnabled: !user.monetizationDisabledAt,
    subscribers: followers >= c.MIN_SUBSCRIBERS,
    watchTime: watchedSeconds >= c.MIN_WATCH_TIME_SECONDS,
    shortsViews: qualifiedShortViews >= c.MIN_SHORT_VIEWS,
    publications: videoPublications + shortPublications >= c.MIN_PUBLICATIONS,
    verified: c.REQUIRE_VERIFIED_ACCOUNT === 0 || !!user.emailVerifiedAt,
    noActiveSanction: c.REQUIRE_NO_ACTIVE_SANCTION === 0 || !['SUSPENDED', 'BANNED'].includes(user.status),
    originalContent: c.REQUIRE_ORIGINAL_CONTENT === 0 || (videoPublications + shortPublications) > 0,
    manualValidation: c.REQUIRE_MANUAL_VALIDATION === 0 || approval?.status === 'APPROVED',
    minimumAge: (user.birthDate ? ageAt(user.birthDate, now) : 0) >= c.MIN_PAYOUT_AGE,
  };
  const reasons = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  const details = buildEligibilityDetails(checks, {
    subscribers: { required: c.MIN_SUBSCRIBERS, current: followers },
    watchTime: { required: c.MIN_WATCH_TIME_SECONDS, current: watchedSeconds },
    shortsViews: { required: c.MIN_SHORT_VIEWS, current: qualifiedShortViews },
    publications: { required: c.MIN_PUBLICATIONS, current: videoPublications + shortPublications },
    minimumAge: { required: c.MIN_PAYOUT_AGE, current: (user.birthDate ? ageAt(user.birthDate, now) : 0) },
  });
  return { eligible: reasons.length === 0, reasons, checks, details, metrics: { subscribers: followers, watchTimeSeconds: watchedSeconds, shortsViews: qualifiedShortViews, publications: videoPublications + shortPublications }, approval: approval?.status ?? 'PENDING' };
}

export async function reviewCreatorEligibility(creatorId: string, status: 'APPROVED' | 'REJECTED', reviewerId: string, rejectionReason?: string) {
  return prisma.creatorMonetizationEligibility.upsert({
    where: { creatorId },
    create: { creatorId, status, reviewedAt: new Date(), reviewedByUserId: reviewerId, rejectionReason: status === 'REJECTED' ? rejectionReason ?? null : null },
    update: { status, reviewedAt: new Date(), reviewedByUserId: reviewerId, rejectionReason: status === 'REJECTED' ? rejectionReason ?? null : null },
  });
}

export type EligibilityDetail = { key: string; met: boolean; required: number | null; current: number | null };

/** Détail condition par condition : pour les critères chiffrés, le seuil exigé et la valeur actuelle ; pour les autres, seulement l'état. */
export function buildEligibilityDetails(checks: Record<string, boolean>, numeric: Record<string, { required: number; current: number }>): EligibilityDetail[] {
  return Object.entries(checks).map(([key, met]) => {
    const n = numeric[key];
    return { key, met, required: n ? n.required : null, current: n ? n.current : null };
  });
}

/** Lecture admin de l'éligibilité : calcul actuel et dernière décision enregistrée. Ne modifie rien. */
export async function getCreatorEligibilityReview(creatorId: string) {
  const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { id: true, username: true, displayName: true, isCreator: true } });
  if (!creator) throw notFound('Créateur introuvable');
  const [evaluation, decision] = await Promise.all([
    evaluateCreatorEligibility(creatorId),
    prisma.creatorMonetizationEligibility.findUnique({ where: { creatorId } }),
  ]);
  return { creator, evaluation, decision };
}
