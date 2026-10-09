import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { forbidden } from '../../utils/errors';
import { getConfigValue } from '../config/config.service';

/** Fenêtres d'acquisition : nombre de jours. */
export const AUDIENCE_RANGES = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;
export type AudienceRange = keyof typeof AUDIENCE_RANGES;
export const DEFAULT_MIN_GROUP = 5;

export type CountryCount = { country: string | null; followers: number };
export type AudienceCountry = { countryCode: string; followers: number; percentage: number };

/**
 * Agrégation pure, sans accès à la base : pourcentages sur le total ; pays non renseigné compté à part ;
 * tout groupe (pays ou « non renseigné ») en dessous du seuil est regroupé dans « Autres ».
 * Aucun identifiant d'abonné n'entre dans cette fonction, donc rien de tel ne peut sortir.
 */
export function aggregateCountries(rows: CountryCount[], minGroup: number) {
  const total = rows.reduce((n, r) => n + r.followers, 0);
  const pct = (n: number) => (total ? Math.round((n * 1000) / total) / 10 : 0);
  const byCode = new Map<string, number>();
  for (const r of rows) {
    const code = r.country && /^[A-Z]{2}$/.test(r.country) ? r.country : 'UNKNOWN';
    byCode.set(code, (byCode.get(code) ?? 0) + r.followers);
  }
  const countries: AudienceCountry[] = [];
  let othersCount = 0;
  let unknownCount = 0;
  for (const [code, n] of byCode) {
    if (code === 'UNKNOWN') { unknownCount = n; continue; }
    if (n < minGroup) othersCount += n;
    else countries.push({ countryCode: code, followers: n, percentage: pct(n) });
  }
  let unknown: { followers: number; percentage: number } | null = null;
  if (unknownCount >= minGroup) unknown = { followers: unknownCount, percentage: pct(unknownCount) };
  else othersCount += unknownCount;
  countries.sort((a, b) => b.followers - a.followers || a.countryCode.localeCompare(b.countryCode));
  const others = othersCount > 0 ? { followers: othersCount, percentage: pct(othersCount) } : null;
  return { totalFollowers: total, countries, others, unknown };
}

/**
 * Audience par pays du créateur connecté, sur les abonnés acquis pendant la fenêtre demandée.
 * Pays = pays déclaré dans le profil (pas une géolocalisation). Comptes supprimés ou suspendus exclus.
 * Réservé au créateur : il ne voit que ses propres données, agrégées.
 */
export async function audienceCountries(creator: User, range: AudienceRange) {
  if (!creator.isCreator) throw forbidden('CREATOR_REQUIRED', 'Réservé aux comptes créateurs');
  const since = new Date(Date.now() - AUDIENCE_RANGES[range] * 86_400_000);
  const configured = Number(await getConfigValue<number>('AUDIENCE.MIN_GROUP_SIZE', DEFAULT_MIN_GROUP));
  const minGroup = Number.isInteger(configured) && configured >= 1 ? configured : DEFAULT_MIN_GROUP;
  const rows = await prisma.$queryRaw<{ country: string | null; followers: bigint }[]>(Prisma.sql`
    SELECT u."country" AS country, COUNT(*)::bigint AS followers
    FROM "Follow" f
    JOIN "User" u ON u."id" = f."followerId"
    WHERE f."followingId" = ${creator.id}
      AND f."createdAt" >= ${since}
      AND u."status" = 'ACTIVE'
    GROUP BY u."country"`);
  const followersAll = await prisma.follow.count({ where: { followingId: creator.id, follower: { status: 'ACTIVE' } } });
  const agg = aggregateCountries(rows.map((r) => ({ country: r.country, followers: Number(r.followers) })), minGroup);
  return {
    range, generatedAt: new Date(), totalFollowers: agg.totalFollowers, followersAll, groupingThreshold: minGroup,
    countries: agg.countries, others: agg.others, unknown: agg.unknown,
  };
}
