import { randomBytes } from 'crypto';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { getConfigValue } from '../config/config.service';
import { payments, type MobileOperator } from '../../utils/payments';
import { assertMobileMoneyCurrency } from '../../utils/currency';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { notify } from '../notifications/notifications.service';
import { creditCreatorWallet } from '../wallet/wallet.service';
import { can } from '../admin/roles';
import { publishToRoom } from '../../realtime/realtime';

const db = prisma;
const COIN_CURRENCY = 'XAF';
const DEFAULT_COIN_COMMISSION_BPS = 2000;

/** Commission plateforme sur cadeaux et pourboires, en points de base (2000 = 20 %). Lue depuis la configuration `COINS.COMMISSION_BPS` ; repli sur 2000 si absente, désactivée ou invalide. */
export async function commissionBps(): Promise<number> {
  const v = await getConfigValue<number>('COINS.COMMISSION_BPS', DEFAULT_COIN_COMMISSION_BPS);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : DEFAULT_COIN_COMMISSION_BPS;
}
export function calculateCoinSplit(points: number, bps = DEFAULT_COIN_COMMISSION_BPS) {
  const platformFee = Math.floor(points * bps / 10000);
  return { grossAmount: points, platformFee, creatorAmount: points - platformFee };
}
const ref = (prefix: string) => `${prefix}${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';

const defaultPackages = [
  ['COINS_500','500 Coins',500,500,0], ['COINS_1000','1 000 Coins',1000,1000,0], ['COINS_2500','2 500 Coins',2500,2500,0], ['COINS_5000','5 000 Coins',5000,5000,0], ['COINS_10000','10 000 Coins',10000,10000,0],
] as const;
const defaultGifts = [
  ['HEART','Cœur','❤️','Amour / affection',10,'COMMON','heart'], ['STRENGTH','Force','💪','Courage / soutien',50,'COMMON','strength'], ['FLAME','Flamme','🔥','Énergie / hype',100,'COMMON','flame'], ['CROWN','Couronne','👑','Respect / admiration',1000,'RARE','crown'], ['STAR','Étoile','🌟','Talent / admiration',500,'RARE','star'], ['DIAMOND','Diamant','💎','Grande valeur',5000,'EPIC','diamond'], ['RESPECT','Respect','🙏','Reconnaissance',100,'COMMON','respect'], ['ROCKET','Fusée','🚀','Ambition / réussite',5000,'EPIC','rocket'], ['LAUGH','Rire','😂','Humour / amusement',10,'COMMON','laugh'], ['CELEBRATION','Célébration','🎉','Félicitations',500,'RARE','celebration'], ['SUPPORT','Soutien','🫶','Proximité / affection',50,'COMMON','support'], ['ENERGY','Énergie','⚡','Motivation',100,'COMMON','energy'],
] as const;

/** Crée les packs et cadeaux par défaut s'ils manquent, sans jamais réécrire un élément existant (modifié par un admin ou non). */
async function ensureDefaults() {
  await Promise.all(defaultPackages.map(([code,name,points,priceAmount,bonusPoints]) => db.coinPackage.upsert({ where:{code}, create:{code,name,points,priceAmount,currency:COIN_CURRENCY,bonusPoints}, update:{} })));
  await Promise.all(defaultGifts.map(([code,name,symbol,meaning,pricePoints,rarity,animationKey]) => db.gift.upsert({ where:{code}, create:{code,name,symbol,meaning,pricePoints,rarity,animationKey}, update:{} })));
}
async function wallet(tx: Prisma.TransactionClient | typeof prisma, userId: string) { return tx.coinWallet.upsert({ where:{userId}, create:{userId}, update:{} }); }

/** Débit atomique : échoue (409) si le solde ne suffit pas ; renvoie le solde après débit (lu après écriture). */
async function debitWallet(tx: Prisma.TransactionClient, walletId: string, points: number, available: number) {
  const r = await tx.coinWallet.updateMany({ where: { id: walletId, balance: { gte: points } }, data: { balance: { decrement: points } } });
  if (!r.count) throw conflict('INSUFFICIENT_COINS', 'Solde de coins insuffisant', { balance: available, required: points });
  return (await tx.coinWallet.findUniqueOrThrow({ where: { id: walletId } })).balance;
}
/** Crédit atomique ; renvoie le solde après crédit. */
async function creditWallet(tx: Prisma.TransactionClient, walletId: string, points: number) {
  return (await tx.coinWallet.update({ where: { id: walletId }, data: { balance: { increment: points } } })).balance;
}

export async function catalog() { await ensureDefaults(); const [gifts, packages] = await Promise.all([db.gift.findMany({where:{active:true},orderBy:[{sortOrder:'asc'},{pricePoints:'asc'}]}), db.coinPackage.findMany({where:{active:true},orderBy:[{sortOrder:'asc'},{points:'asc'}]})]); return { gifts, packages }; }
export async function balance(user: User) { const w=await wallet(db,user.id); return { balance:w.balance, wallet:w }; }
export async function ledger(user: User) { return { entries: await db.coinLedgerEntry.findMany({where:{userId:user.id},orderBy:{createdAt:'desc'},take:100}) }; }

export async function buyCoins(user: User, input:{packageId:string;operator:MobileOperator;phone:string}) {
  const p=await db.coinPackage.findUnique({where:{id:input.packageId}}); if(!p||!p.active) throw notFound('Pack de coins indisponible');
  assertMobileMoneyCurrency(p.currency); if(!payments.operators().includes(input.operator)) throw badRequest('OPERATOR_UNAVAILABLE','Cet opérateur n’est pas disponible');
  const existing=await db.coinPurchase.findFirst({where:{userId:user.id,packageId:p.id,status:{in:['PENDING','REVIEW']}}}); if(existing) throw conflict('PAYMENT_IN_PROGRESS','Un achat de coins est déjà en cours',{purchaseId:existing.id});
  const purchase=await db.coinPurchase.create({data:{reference:ref('K'),userId:user.id,packageId:p.id,points:p.points+p.bonusPoints,grossAmount:p.priceAmount,currency:p.currency,operator:input.operator,payerPhoneHint:input.phone.slice(-4)}});
  // Rien n'est parti chez le prestataire si l'appel lève une exception : échec définitif, nouvel essai possible (même règle que les messages payants).
  let r;
  try { r = await payments.initiate({reference:purchase.reference,amount:p.priceAmount,currency:p.currency,operator:input.operator,phone:input.phone,description:'Achat de coins Face to Face'}); }
  catch (e) { await db.coinPurchase.updateMany({where:{id:purchase.id,status:'PENDING'},data:{status:'FAILED'}}); throw e; }
  if (r.status==='REJECTED') { await db.coinPurchase.updateMany({where:{id:purchase.id,status:'PENDING'},data:{status:'FAILED'}}); throw badRequest('PAYMENT_FAILED',r.message||'Paiement refusé'); }
  if (r.status==='ACCEPTED'&&r.providerRef) await db.coinPurchase.updateMany({where:{id:purchase.id,status:'PENDING'},data:{externalRef:r.providerRef}});
  if (r.status==='REDIRECT'&&r.providerRef) await db.coinPurchase.updateMany({where:{id:purchase.id,status:'PENDING'},data:{externalRef:r.providerRef}});
  const current=await db.coinPurchase.findUniqueOrThrow({where:{id:purchase.id}});
  return r.status==='REDIRECT' ? {status:current.status,purchase:current,checkoutUrl:r.url} : {status:current.status,purchase:current};
}

/** Statut d'un achat pour son acheteur (sondé par l'application après un 202). */
export async function purchaseStatus(user: User, id: string) {
  const p = await db.coinPurchase.findUnique({ where: { id } });
  if (!p || p.userId !== user.id) throw notFound('Achat introuvable');
  return { purchase: { id: p.id, status: p.status, points: p.points, grossAmount: p.grossAmount, currency: p.currency, operator: p.operator, initiatedAt: p.initiatedAt, paidAt: p.paidAt, review: p.status === 'REVIEW' } };
}

/**
 * SEUL point de passage d'un achat de coins vers PAID / FAILED / REVIEW (webhook, rapprochement). Idempotent.
 * Règles alignées sur les achats de messages : un succès reçu après un échec part en REVIEW (jamais ignoré) ; un montant inférieur au prix part en REVIEW.
 */
export async function settleCoinPurchase(reference: string, o: { status: 'SUCCESS' | 'FAILED'; amount?: number; providerRef?: string; payload?: unknown }) {
  const payload = o.payload === undefined ? undefined : (JSON.parse(JSON.stringify(o.payload)) as Prisma.InputJsonValue);
  return db.$transaction(async (tx) => {
    const p = await tx.coinPurchase.findUnique({ where: { reference } });
    if (!p) return 'unknown' as const;
    if (p.status === 'PAID') return 'already' as const;
    if (o.status === 'SUCCESS') {
      if (p.status === 'FAILED') {
        await tx.coinPurchase.updateMany({ where: { id: p.id, status: 'FAILED' }, data: { status: 'REVIEW', reviewReason: 'LATE_SUCCESS', providerPayload: payload } });
        console.error(`[coins] succès tardif sur un achat échoué (réf ${reference}) : vérification manuelle / remboursement requis`);
        return 'review' as const;
      }
      if (o.amount !== undefined && o.amount < p.grossAmount) {
        await tx.coinPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'REVIEW', reviewReason: 'AMOUNT_MISMATCH', providerPayload: payload } });
        return 'review' as const;
      }
      const u = await tx.coinPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'PAID', paidAt: new Date(), reviewReason: null, externalRef: o.providerRef ?? p.externalRef, providerPayload: payload } });
      if (u.count !== 1) return 'already' as const;
      const w = await wallet(tx, p.userId);
      const next = await creditWallet(tx, w.id, p.points);
      await tx.coinLedgerEntry.create({ data: { walletId: w.id, userId: p.userId, type: 'PURCHASE', amount: p.points, balanceAfter: next, sourceType: 'COIN_PURCHASE', sourceId: p.id, description: `Achat de ${p.points} coins` } });
      return 'paid' as const;
    }
    if (p.status === 'FAILED') return 'already' as const;
    const r = await tx.coinPurchase.updateMany({ where: { id: p.id, status: { in: ['PENDING', 'REVIEW'] } }, data: { status: 'FAILED', providerPayload: payload } });
    return r.count === 1 ? ('failed' as const) : ('already' as const);
  });
}

/** Événement GIFT_SENT pour la salle du Live. N'est appelé qu'après validation de la transaction cadeau. */
function publishGiftSent(liveId: string, sender: User, gift: { id: string; code: string; name: string; symbol: string; animationKey: string | null }, giftTx: { id: string; quantity: number; message: string | null; createdAt: Date }) {
  publishToRoom(liveId, { type: 'GIFT_SENT', payload: { liveId, id: giftTx.id, giftId: gift.id, code: gift.code, name: gift.name, symbol: gift.symbol, animationKey: gift.animationKey, quantity: giftTx.quantity, message: giftTx.message, sender: { id: sender.id, displayName: sender.displayName, avatarUrl: sender.avatarUrl }, createdAt: giftTx.createdAt } });
}

async function giftReplay(senderId: string, key: string) {
  const row = await db.coinGiftTransaction.findUnique({ where: { senderId_idempotencyKey: { senderId, idempotencyKey: key } } });
  if (!row) return null;
  const w = await db.coinWallet.findUnique({ where: { userId: senderId } });
  return { gift: row, balance: w?.balance ?? 0, replayed: true as const };
}
async function tipReplay(senderId: string, key: string) {
  const row = await db.coinTipTransaction.findUnique({ where: { senderId_idempotencyKey: { senderId, idempotencyKey: key } } });
  if (!row) return null;
  const w = await db.coinWallet.findUnique({ where: { userId: senderId } });
  return { tip: row, balance: w?.balance ?? 0, replayed: true as const };
}

/** Envoi d'un cadeau. Une même `idempotencyKey` envoyée deux fois ne débite qu'une fois : le second appel renvoie le premier envoi. */
export async function sendGift(user: User, input: { creatorId: string; giftId: string; quantity: number; liveId?: string; message?: string; idempotencyKey?: string }) {
  if (user.id === input.creatorId) throw badRequest('CANNOT_GIFT_SELF','Vous ne pouvez pas vous envoyer un cadeau');
  if (input.idempotencyKey) { const prev = await giftReplay(user.id, input.idempotencyKey); if (prev) return prev; }
  const gift = await db.gift.findUnique({ where: { id: input.giftId } });
  if (!gift || !gift.active) throw notFound('Cadeau indisponible');
  if (input.liveId) { const live = await db.live.findUnique({ where: { id: input.liveId }, select: { id: true, hostId: true, status: true } }); if (!live || live.hostId !== input.creatorId || live.status !== 'LIVE') throw badRequest('INVALID_LIVE','Live invalide'); }
  const points = gift.pricePoints * input.quantity;
  if (!Number.isSafeInteger(points)) throw badRequest('INVALID_QUANTITY','Quantité invalide');
  const bps = await commissionBps();
  try {
    const result = await db.$transaction(async (tx) => {
      const w = await wallet(tx, user.id);
      const balanceAfter = await debitWallet(tx, w.id, points, w.balance);
      const split = calculateCoinSplit(points, bps);
      const giftTx = await tx.coinGiftTransaction.create({ data: { senderId: user.id, creatorId: input.creatorId, giftId: gift.id, liveId: input.liveId, quantity: input.quantity, pointsSpent: points, grossAmount: split.grossAmount, platformFee: split.platformFee, creatorAmount: split.creatorAmount, currency: COIN_CURRENCY, message: input.message || null, idempotencyKey: input.idempotencyKey ?? null } });
      await tx.coinLedgerEntry.create({ data: { walletId: w.id, userId: user.id, type: 'GIFT_SPENT', amount: -points, balanceAfter, sourceType: 'GIFT', sourceId: giftTx.id, description: `${gift.name} x${input.quantity}` } });
      await creditCreatorWallet(tx, { creatorId: input.creatorId, sourceType: 'GIFT', sourceId: giftTx.id, amount: split.creatorAmount, currency: COIN_CURRENCY, description: `Cadeau ${gift.name}` });
      await notify(tx, { userId: input.creatorId, type: 'GIFT_RECEIVED', actorId: user.id, targetType: 'GIFT', targetId: giftTx.id, amount: split.creatorAmount, currency: COIN_CURRENCY });
      return { gift: giftTx, balance: balanceAfter };
    });
    if (input.liveId) publishGiftSent(input.liveId, user, gift, result.gift);
    return result;
  } catch (e) {
    // Deux envois simultanés avec la même clé : la transaction du second est annulée (aucun double débit) ; on renvoie le premier.
    if (input.idempotencyKey && isUniqueViolation(e)) { const prev = await giftReplay(user.id, input.idempotencyKey); if (prev) return prev; }
    throw e;
  }
}

/** Envoi d'un pourboi, mêmes garanties que le cadeau. Montants en coins, bornés par TIP_MIN_FCFA / TIP_MAX_FCFA (unités de coins). */
export async function sendTip(user: User, input: { creatorId: string; amount: number; message?: string; liveId?: string; idempotencyKey?: string }) {
  if (user.id === input.creatorId) throw badRequest('CANNOT_TIP_SELF','Vous ne pouvez pas vous envoyer un pourboire');
  if (input.amount <= 0) throw badRequest('INVALID_AMOUNT','Montant invalide');
  if (input.amount < env.TIP_MIN_FCFA || input.amount > env.TIP_MAX_FCFA) throw badRequest('TIP_AMOUNT_OUT_OF_RANGE', `Montant entre ${env.TIP_MIN_FCFA} et ${env.TIP_MAX_FCFA} coins`, { min: env.TIP_MIN_FCFA, max: env.TIP_MAX_FCFA });
  if (input.idempotencyKey) { const prev = await tipReplay(user.id, input.idempotencyKey); if (prev) return prev; }
  const bps = await commissionBps();
  const points = input.amount;
  try {
    return await db.$transaction(async (tx) => {
      const w = await wallet(tx, user.id);
      const balanceAfter = await debitWallet(tx, w.id, points, w.balance);
      const split = calculateCoinSplit(points, bps);
      const tip = await tx.coinTipTransaction.create({ data: { senderId: user.id, creatorId: input.creatorId, amount: points, platformFee: split.platformFee, creatorAmount: split.creatorAmount, currency: COIN_CURRENCY, message: input.message || null, liveId: input.liveId || null, idempotencyKey: input.idempotencyKey ?? null } });
      await tx.coinLedgerEntry.create({ data: { walletId: w.id, userId: user.id, type: 'GIFT_SPENT', amount: -points, balanceAfter, sourceType: 'TIP', sourceId: tip.id, description: 'Pourboire' } });
      await creditCreatorWallet(tx, { creatorId: input.creatorId, sourceType: 'TIP', sourceId: tip.id, amount: split.creatorAmount, currency: COIN_CURRENCY, description: 'Pourboire en coins' });
      await notify(tx, { userId: input.creatorId, type: 'TIP_RECEIVED', actorId: user.id, targetType: 'TIP', targetId: tip.id, amount: split.creatorAmount, currency: COIN_CURRENCY });
      return { tip, balance: balanceAfter };
    });
  } catch (e) {
    if (input.idempotencyKey && isUniqueViolation(e)) { const prev = await tipReplay(user.id, input.idempotencyKey); if (prev) return prev; }
    throw e;
  }
}

export async function adminGifts(user:User){if(!can(user, 'finance.coins.view'))throw forbidden('ADMIN_REQUIRED','Droits administrateur requis');await ensureDefaults();return{gifts:await db.gift.findMany({orderBy:[{sortOrder:'asc'},{pricePoints:'asc'}]})};}
export async function adminPackages(user:User){if(!can(user, 'finance.coins.view'))throw forbidden('ADMIN_REQUIRED','Droits administrateur requis');await ensureDefaults();return{packages:await db.coinPackage.findMany({orderBy:[{sortOrder:'asc'},{points:'asc'}]})};}
export { upsertGift, upsertPackage } from './coins.admin.service';
