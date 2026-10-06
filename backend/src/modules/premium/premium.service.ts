import { randomBytes } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { payments, type MobileOperator } from '../../utils/payments';
import { normalizeCurrency } from '../monetization/currency';
import { syncPaymentTransaction } from '../wallet/wallet.service';

type DB = Prisma.TransactionClient | typeof prisma;
const reference = () => `P${Date.now().toString(36).slice(-7)}${randomBytes(3).toString('hex')}`.toUpperCase();
const DEFAULT_BENEFITS = { adFree: true, premiumBadge: true };
const adminIds = () => env.PREMIUM_ADMIN_USER_IDS.split(',').map(v => v.trim()).filter(Boolean);
const isAdmin = (id: string) => adminIds().includes(id);

async function setting(db: DB) {
  return db.premiumSetting.upsert({ where: { id: 'default' }, create: { id: 'default', monthlyPriceMinor: env.PREMIUM_DEFAULT_MONTHLY_PRICE, annualPriceMinor: env.PREMIUM_DEFAULT_ANNUAL_PRICE, currency: 'XAF', trialDays: env.PREMIUM_DEFAULT_TRIAL_DAYS, benefits: DEFAULT_BENEFITS }, update: {} });
}
const dto = (s: any) => ({ id: s.id, status: s.status, billingPeriod: s.billingPeriod, currency: s.currency, priceAmount: s.priceAmount, discountAmount: s.discountAmount, startedAt: s.startedAt, expiresAt: s.expiresAt, trialEndsAt: s.trialEndsAt, autoRenew: s.autoRenew, cancelledAt: s.cancelledAt });

export async function getSettings() { const s = await setting(prisma); return { ...s, benefits: { ...DEFAULT_BENEFITS, ...(s.benefits as any ?? {}) } }; }
export async function updateSettings(userId: string, input: any) {
  if (!isAdmin(userId)) throw forbidden('ADMIN_REQUIRED', 'Droits administrateur requis');
  return prisma.premiumSetting.upsert({ where: { id: 'default' }, create: { id: 'default', monthlyPriceMinor: input.monthlyPriceMinor ?? env.PREMIUM_DEFAULT_MONTHLY_PRICE, annualPriceMinor: input.annualPriceMinor ?? env.PREMIUM_DEFAULT_ANNUAL_PRICE, currency: input.currency ?? 'XAF', trialDays: input.trialDays ?? env.PREMIUM_DEFAULT_TRIAL_DAYS, benefits: { ...DEFAULT_BENEFITS, ...(input.benefits ?? {}) }, ...input, updatedByUserId: userId }, update: { ...input, benefits: input.benefits ? { ...DEFAULT_BENEFITS, ...input.benefits } : undefined, updatedByUserId: userId } });
}

export async function getMySubscription(user: User) {
  const s = await prisma.premiumSubscription.findUnique({ where: { userId: user.id } });
  const active = !!s && ['ACTIVE','TRIAL'].includes(s.status) && !!s.expiresAt && s.expiresAt > new Date();
  if (s && active) return { subscription: dto(s), active: true };
  if (s && s.status !== 'EXPIRED' && s.expiresAt && s.expiresAt <= new Date()) { await prisma.premiumSubscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } }); }
  return { subscription: s ? dto({ ...s, status: active ? s.status : 'EXPIRED' }) : null, active: false };
}

export async function hasActivePremium(userId: string) {
  const s = await prisma.premiumSubscription.findUnique({ where: { userId }, select: { status: true, expiresAt: true } });
  return !!s && ['ACTIVE','TRIAL'].includes(s.status) && !!s.expiresAt && s.expiresAt > new Date();
}

async function priceFor(db: DB, billingPeriod: 'MONTHLY'|'ANNUAL', code?: string) {
  const s = await setting(db);
  const base = billingPeriod === 'MONTHLY' ? s.monthlyPriceMinor : s.annualPriceMinor;
  let discount = 0; let promotionCode: string | undefined;
  if (code) {
    const p = await db.premiumPromotion.findUnique({ where: { code: code.toUpperCase() } });
    const now = new Date();
    if (!p || !p.isActive || p.startsAt > now || p.endsAt <= now || (p.maxRedemptions !== null && p.redemptionCount >= p.maxRedemptions)) throw badRequest('INVALID_PREMIUM_PROMOTION', 'Promotion Premium invalide ou expirée');
    if (p.type === 'PERCENT') discount = Math.floor(base * p.value / 10_000);
    else { if (p.currency && p.currency !== s.currency) throw badRequest('PROMOTION_CURRENCY_MISMATCH', 'Cette promotion n’utilise pas la devise Premium'); discount = p.value; }
    discount = Math.min(discount, base); promotionCode = p.code;
  }
  return { currency: normalizeCurrency(s.currency), base, discount, net: base - discount, promotionCode, setting: s };
}

export async function startTrial(user: User) {
  const s = await setting(prisma);
  if (!s.trialEnabled || s.trialDays <= 0) throw conflict('PREMIUM_TRIAL_DISABLED', 'L’essai gratuit Premium est désactivé');
  if (await hasActivePremium(user.id)) throw conflict('PREMIUM_ALREADY_ACTIVE', 'Votre Premium est déjà actif');
  const existing = await prisma.premiumSubscription.findUnique({ where: { userId: user.id } });
  if (existing && existing.trialEndsAt) throw conflict('PREMIUM_TRIAL_ALREADY_USED', 'L’essai gratuit Premium a déjà été utilisé');
  const now = new Date(); const expires = new Date(now.getTime() + s.trialDays * 86400000);
  const sub = await prisma.premiumSubscription.upsert({ where: { userId: user.id }, create: { userId: user.id, status: 'TRIAL', billingPeriod: 'MONTHLY', currency: s.currency, priceAmount: 0, trialEndsAt: expires, startedAt: now, expiresAt: expires, autoRenew: false }, update: { status: 'TRIAL', billingPeriod: 'MONTHLY', currency: s.currency, priceAmount: 0, discountAmount: 0, trialEndsAt: expires, startedAt: now, expiresAt: expires, cancelledAt: null, autoRenew: false } });
  return { subscription: dto(sub), active: true };
}

export async function subscribe(user: User, input: { billingPeriod:'MONTHLY'|'ANNUAL'; operator: MobileOperator; phone: string; promotionCode?: string }) {
  const s = await setting(prisma);
  if (!s.enabled) throw conflict('PREMIUM_DISABLED', 'Face to Face Premium est désactivé');
  if (await hasActivePremium(user.id)) throw conflict('PREMIUM_ALREADY_ACTIVE', 'Votre Premium est déjà actif');
  if (s.currency !== 'XAF') throw conflict('PREMIUM_CURRENCY_UNAVAILABLE', 'Le paiement Premium Mobile Money utilise actuellement le XAF');
  const price = await priceFor(prisma, input.billingPeriod, input.promotionCode);
  if (price.net <= 0) throw badRequest('INVALID_PREMIUM_PRICE', 'Le prix Premium calculé est invalide');
  const existing = await prisma.premiumSubscription.findUnique({ where: { userId: user.id } });
  const sub = existing ? await prisma.premiumSubscription.update({ where: { id: existing.id }, data: { status:'PENDING_PAYMENT', billingPeriod:input.billingPeriod, currency:price.currency, priceAmount:price.net, discountAmount:price.discount, startedAt:null, expiresAt:null, cancelledAt:null } }) : await prisma.premiumSubscription.create({ data: { userId:user.id, status:'PENDING_PAYMENT', billingPeriod:input.billingPeriod, currency:price.currency, priceAmount:price.net, discountAmount:price.discount } });
  const ref = reference();
  const payment = await prisma.premiumPayment.create({ data: { subscriptionId:sub.id, userId:user.id, billingPeriod:input.billingPeriod, grossAmount:price.base, discountAmount:price.discount, netAmount:price.net, currency:price.currency, reference:ref, operator:input.operator, payerPhoneHint:input.phone.slice(-4), promotionCode:price.promotionCode } });
  try {
    const result = await payments.initiate({ reference:ref, amountFcfa:price.net, operator:input.operator, phone:input.phone, description:`Face to Face Premium ${input.billingPeriod === 'ANNUAL' ? 'annuel' : 'mensuel'}` });
    if (result.status === 'REJECTED') { await prisma.premiumPayment.update({ where:{id:payment.id}, data:{status:'FAILED',reviewReason:result.code} }); throw new AppError(402,'PAYMENT_FAILED',result.message || 'Le paiement a été refusé',{code:result.code}); }
    if (result.status === 'ACCEPTED' && result.providerRef) await prisma.premiumPayment.update({ where:{id:payment.id}, data:{externalRef:result.providerRef} });
  } catch (err) { if (err instanceof AppError && err.code === 'PAYMENT_FAILED') throw err; if (err instanceof AppError) { await prisma.premiumPayment.update({where:{id:payment.id},data:{status:'FAILED',reviewReason:err.code}}); } throw err; }
  return { httpStatus:202 as const, subscription:dto(sub), payment:{ id:payment.id, status:'PENDING', reference:ref, amount:price.net, currency:price.currency } };
}

export async function cancelRenewal(user: User) {
  const s = await prisma.premiumSubscription.findUnique({ where:{userId:user.id} });
  if (!s || !['ACTIVE','TRIAL'].includes(s.status)) throw notFound('Abonnement Premium introuvable');
  return { subscription:dto(await prisma.premiumSubscription.update({where:{id:s.id},data:{autoRenew:false,cancelledAt:new Date()}})) };
}

export async function renew(user: User, input: { operator:MobileOperator; phone:string; promotionCode?:string }) {
  const current = await prisma.premiumSubscription.findUnique({where:{userId:user.id}});
  if (!current || !['ACTIVE','EXPIRED','CANCELLED'].includes(current.status)) throw conflict('PREMIUM_RENEWAL_UNAVAILABLE','Renouvellement Premium indisponible');
  return subscribe(user,{billingPeriod:current.billingPeriod as any,operator:input.operator,phone:input.phone,promotionCode:input.promotionCode});
}

export async function settlePremiumPayment(ref:string,outcome:{status:'SUCCESS'|'FAILED';amountFcfa?:number;providerRef?:string;payload?:unknown}) {
  return prisma.$transaction(async tx=>{
    const p=await tx.premiumPayment.findUnique({where:{reference:ref},include:{subscription:true}});
    if(!p) return 'unknown' as const; if(p.status==='PAID') return 'already' as const;
    const payload=outcome.payload===undefined?undefined:JSON.parse(JSON.stringify(outcome.payload));
    if(outcome.status==='SUCCESS'){
      if(p.status==='FAILED'){await tx.premiumPayment.update({where:{id:p.id},data:{status:'REVIEW',reviewReason:'LATE_SUCCESS',providerPayload:payload}}); return 'review' as const;}
      if(outcome.amountFcfa!==undefined && outcome.amountFcfa<p.netAmount){await tx.premiumPayment.update({where:{id:p.id},data:{status:'REVIEW',reviewReason:'AMOUNT_MISMATCH',providerPayload:payload}}); return 'review' as const;}
      const now=new Date(); const r=await tx.premiumPayment.updateMany({where:{id:p.id,status:{in:['PENDING','REVIEW']}},data:{status:'PAID',paidAt:now,providerPayload:payload,reviewReason:null,...(outcome.providerRef?{externalRef:outcome.providerRef}:{})}});
      if(r.count!==1) return 'already' as const;
      const start=now; const days=p.billingPeriod==='ANNUAL'?365:30; const expires=new Date(start.getTime()+days*86400000);
      await tx.premiumSubscription.update({where:{id:p.subscriptionId},data:{status:'ACTIVE',startedAt:start,expiresAt:expires,autoRenew:true,cancelledAt:null,priceAmount:p.netAmount,discountAmount:p.discountAmount}});
      if (p.promotionCode) await tx.premiumPromotion.updateMany({ where: { code: p.promotionCode }, data: { redemptionCount: { increment: 1 } } });
      return 'paid' as const;
    }
    const r=await tx.premiumPayment.updateMany({where:{id:p.id,status:{in:['PENDING','REVIEW']}},data:{status:'FAILED',reviewReason:null,providerPayload:payload}});
    return r.count===1?'failed' as const:'already' as const;
  });
}

export async function createPromotion(user:User,input:any){ if(!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis'); if(input.endsAt<=input.startsAt) throw badRequest('INVALID_PROMOTION_DATES','La fin doit être après le début'); if(input.type==='PERCENT' && input.value>10000) throw badRequest('INVALID_PROMOTION_VALUE','Pourcentage maximal : 100 %'); return prisma.premiumPromotion.create({data:{...input,createdById:user.id}}); }
export async function listPromotions(user:User){ if(!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis'); return prisma.premiumPromotion.findMany({orderBy:{createdAt:'desc'},take:200}); }
export async function setPromotionStatus(user:User,id:string,isActive:boolean){ if(!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis'); return prisma.premiumPromotion.update({where:{id},data:{isActive}}); }
