import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { payments, type MobileOperator } from '../../utils/payments';
import { assertMobileMoneyCurrency, assertPriceInRange, isSupportedCurrency } from '../../utils/currency';
import { splitRecord } from '../../utils/money';
import { badRequest, conflict, forbidden, notFound, AppError } from '../../utils/errors';
import { recordCreatorEarning } from './monetization.service';
import { isAdmin } from '../admin/admin.service';
import { notify } from '../notifications/notifications.service';

const giftReference = () => `G${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();
const tipReference = () => `T${Date.now().toString(36).slice(-6)}${randomBytes(3).toString('hex')}`.toUpperCase();

async function creator(id:string) {
  const user=await prisma.user.findUnique({where:{id}});
  if(!user || user.status!=='ACTIVE' || !user.isCreator || user.monetizationDisabledAt) throw notFound('Créateur introuvable');
  return user;
}

export async function catalog() {
  const gifts=await prisma.gift.findMany({where:{active:true},orderBy:[{sortOrder:'asc'},{createdAt:'asc'}]});
  return {gifts};
}

export async function sendGift(user:User,input:{creatorId:string;giftId:string;operator:MobileOperator;phone:string;liveId?:string}) {
  if(user.id===input.creatorId) throw badRequest('CANNOT_SUPPORT_SELF','Vous ne pouvez pas vous envoyer un cadeau');
  const c=await creator(input.creatorId);
  const gift=await prisma.gift.findUnique({where:{id:input.giftId}});
  if(!gift || !gift.active) throw notFound('Cadeau indisponible');
  if(!isSupportedCurrency(gift.currency)) throw badRequest('UNSUPPORTED_CURRENCY','Devise du cadeau non prise en charge');
  if(!payments.operators().includes(input.operator)){
    if(!payments.operators().length) throw new AppError(503,'PAYMENTS_NOT_CONFIGURED','Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE',"Cet opérateur n'est pas disponible");
  }
  assertMobileMoneyCurrency(gift.currency);
  assertPriceInRange(gift.price,gift.currency,env.TIP_MIN_FCFA,env.TIP_MAX_FCFA,'INVALID_GIFT_PRICE');
  if(input.liveId){
    const live=await prisma.live.findUnique({where:{id:input.liveId},select:{id:true,hostId:true,status:true}});
    if(!live || live.hostId!==c.id || live.status!=='LIVE') throw badRequest('INVALID_LIVE','Live invalide ou terminé');
  }
  const split=splitRecord(gift.price,env.GIFT_COMMISSION_BPS,gift.currency);
  const ref=giftReference();
  const tx=await prisma.giftTransaction.create({data:{senderId:user.id,creatorId:c.id,giftId:gift.id,liveId:input.liveId,...split,reference:ref,operator:input.operator,payerPhoneHint:input.phone.slice(-4)}});
  let result;
  try{result=await payments.initiate({reference:ref,amount:split.grossAmount,currency:split.currency,operator:input.operator,phone:input.phone,description:`Cadeau ${gift.name}`});}
  catch(e){await prisma.giftTransaction.update({where:{id:tx.id},data:{status:'FAILED'}});throw e;}
  if(result.status==='REJECTED'){await prisma.giftTransaction.update({where:{id:tx.id},data:{status:'FAILED',reviewReason:result.code}});throw new AppError(402,'PAYMENT_FAILED',result.message||'Le paiement a été refusé',{code:result.code});}
  if(result.status==='ACCEPTED'&&result.providerRef) await prisma.giftTransaction.update({where:{id:tx.id},data:{externalRef:result.providerRef}});
  const now=await prisma.giftTransaction.findUniqueOrThrow({where:{id:tx.id}});
  return {purchase:{id:now.id,giftId:now.giftId,creatorId:now.creatorId,amount:now.grossAmount,currency:now.currency,status:now.status,createdAt:now.createdAt}};
}

export async function sendTip(user:User,input:{creatorId:string;amount:number;currency:string;operator:MobileOperator;phone:string;liveId?:string;message?:string}) {
  if(user.id===input.creatorId) throw badRequest('CANNOT_SUPPORT_SELF','Vous ne pouvez pas vous envoyer un tip');
  const c=await creator(input.creatorId);
  if(!isSupportedCurrency(input.currency)) throw badRequest('UNSUPPORTED_CURRENCY','Devise non prise en charge');
  assertMobileMoneyCurrency(input.currency);
  assertPriceInRange(input.amount,input.currency,env.TIP_MIN_FCFA,env.TIP_MAX_FCFA,'INVALID_TIP_AMOUNT');
  if(!payments.operators().includes(input.operator)){
    if(!payments.operators().length) throw new AppError(503,'PAYMENTS_NOT_CONFIGURED','Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE',"Cet opérateur n'est pas disponible");
  }
  if(input.liveId){
    const live=await prisma.live.findUnique({where:{id:input.liveId},select:{id:true,hostId:true,status:true}});
    if(!live || live.hostId!==c.id || live.status!=='LIVE') throw badRequest('INVALID_LIVE','Live invalide ou terminé');
  }
  const split=splitRecord(input.amount,env.GIFT_COMMISSION_BPS,input.currency);
  const ref=tipReference();
  const tx=await prisma.tip.create({data:{senderId:user.id,creatorId:c.id,liveId:input.liveId,amount:split.grossAmount,commissionAmount:split.commissionAmount,creatorAmount:split.creatorAmount,currency:split.currency,commissionBps:split.commissionBps,message:input.message||null,reference:ref,operator:input.operator,payerPhoneHint:input.phone.slice(-4)}});
  let result;
  try{result=await payments.initiate({reference:ref,amount:split.grossAmount,currency:split.currency,operator:input.operator,phone:input.phone,description:'Tip Face to Face'});}
  catch(e){await prisma.tip.update({where:{id:tx.id},data:{status:'FAILED'}});throw e;}
  if(result.status==='REJECTED'){await prisma.tip.update({where:{id:tx.id},data:{status:'FAILED',reviewReason:result.code}});throw new AppError(402,'PAYMENT_FAILED',result.message||'Le paiement a été refusé',{code:result.code});}
  if(result.status==='ACCEPTED'&&result.providerRef) await prisma.tip.update({where:{id:tx.id},data:{externalRef:result.providerRef}});
  const now=await prisma.tip.findUniqueOrThrow({where:{id:tx.id}});
  return {tip:{id:now.id,creatorId:now.creatorId,amount:now.amount,currency:now.currency,status:now.status,createdAt:now.createdAt}};
}

export async function seedDefaultGifts() {
  const defaults=[
    ['Cœur','Amour / affection','❤️',100,'XAF','common'],
    ['Force','Courage / soutien','💪',200,'XAF','common'],
    ['Flamme','Énergie / hype','🔥',300,'XAF','common'],
    ['Couronne','Respect / admiration','👑',1000,'XAF','rare'],
    ['Étoile','Talent / admiration','🌟',500,'XAF','common'],
    ['Diamant','Grande valeur','💎',2500,'XAF','epic'],
    ['Respect','Reconnaissance','🙏',300,'XAF','common'],
    ['Fusée','Ambition / réussite','🚀',5000,'XAF','legendary'],
    ['Rire','Humour / amusement','😂',100,'XAF','common'],
    ['Célébration','Félicitations','🎉',500,'XAF','common'],
    ['Soutien','Proximité / affection','🫶',200,'XAF','common'],
    ['Énergie','Motivation','⚡',300,'XAF','common'],
  ] as const;
  for(const [name,description,emoji,price,currency,rarity] of defaults){
    await prisma.gift.upsert({where:{id:`default-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`},update:{},create:{id:`default-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,name,description,emoji,price,currency,rarity,active:true}});
  }
}

export async function adminList(user: User) {
  if (!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis');
  return { gifts: await prisma.gift.findMany({ orderBy:[{sortOrder:'asc'},{createdAt:'asc'}] }) };
}
export async function adminCreate(user: User, input: { name:string; description?:string|null; emoji:string; imageKey?:string|null; animationKey?:string|null; rarity?:string|null; price:number; currency:string; active?:boolean; sortOrder?:number }) {
  if (!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis');
  if (!isSupportedCurrency(input.currency)) throw badRequest('UNSUPPORTED_CURRENCY','Devise non prise en charge');
  assertPriceInRange(input.price,input.currency,env.TIP_MIN_FCFA,env.TIP_MAX_FCFA,'INVALID_GIFT_PRICE');
  return prisma.gift.create({data:{...input,currency:input.currency.toUpperCase(),active:input.active??true,sortOrder:input.sortOrder??0}});
}
export async function adminUpdate(user: User, id: string, input: Partial<{ name:string; description:string|null; emoji:string; imageKey:string|null; animationKey:string|null; rarity:string|null; price:number; currency:string; active:boolean; sortOrder:number }>) {
  if (!isAdmin(user.id)) throw forbidden('ADMIN_REQUIRED','Droits administrateur requis');
  const existing=await prisma.gift.findUnique({where:{id}});
  if(!existing) throw notFound('Cadeau introuvable');
  const currency=input.currency?.toUpperCase() ?? existing.currency;
  if(!isSupportedCurrency(currency)) throw badRequest('UNSUPPORTED_CURRENCY','Devise non prise en charge');
  if(input.price!==undefined) assertPriceInRange(input.price,currency,env.TIP_MIN_FCFA,env.TIP_MAX_FCFA,'INVALID_GIFT_PRICE');
  return prisma.gift.update({where:{id},data:{...input,currency}});
}
