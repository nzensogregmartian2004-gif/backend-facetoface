import { randomBytes } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { payments, type MobileOperator } from '../../utils/payments';
import { assertMobileMoneyCurrency, assertPriceInRange } from '../../utils/currency';
import { splitRecord } from '../../utils/money';
import { badRequest, conflict, forbidden, notFound, AppError } from '../../utils/errors';
import { serializeOne } from './content.serializer';
import { loadVisible } from './access';
import type { Kind } from './types';
import { hasActiveSubscription } from '../subscriptions/subscriptions.service';

const reference = () => `VC${Date.now().toString(36).slice(-5)}${randomBytes(3).toString('hex')}`.toUpperCase();

export async function purchase(user: User, kind: Kind, contentId: string, input: { operator: MobileOperator; phone: string }) {
  const row = await loadVisible(user, kind, contentId);
  if (row.authorId === user.id) throw badRequest('CANNOT_PURCHASE_OWN_CONTENT', 'Vous ne pouvez pas acheter votre propre contenu');
  if (row.price == null || !row.currency) throw badRequest('CONTENT_NOT_PAID', 'Ce contenu n’est pas payant');
  if (row.subscriptionOnly && !(await hasActiveSubscription(user.id, row.authorId))) {
    throw forbidden('SUBSCRIPTION_REQUIRED', 'Un abonnement actif est requis pour acheter ce contenu');
  }
  if (!payments.operators(user.country).includes(input.operator)) {
    if (!payments.operators(user.country).length) throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Les paiements ne sont pas encore configurés sur ce serveur');
    throw badRequest('OPERATOR_UNAVAILABLE', "Cet opérateur n'est pas disponible");
  }
  assertMobileMoneyCurrency(row.currency);
  assertPriceInRange(row.price, row.currency, env.PAID_CONTENT_MIN_FCFA, env.PAID_CONTENT_MAX_FCFA, 'INVALID_CONTENT_PRICE');

  const existing = await prisma.paidContentPurchase.findUnique({ where: { contentType_contentId_buyerId: { contentType: kind, contentId, buyerId: user.id } } });
  if (existing?.status === 'PAID') return { httpStatus: 200 as const, status:'PAID' as const, alreadyPurchased:true, content: await serializeOne(kind,row,user) };
  if (existing?.status === 'PENDING') throw conflict('PAYMENT_IN_PROGRESS','Un paiement est déjà en cours',{purchaseId:existing.id});
  if (existing?.status === 'REVIEW') throw conflict('PAYMENT_UNDER_REVIEW','Votre paiement est en cours de vérification',{purchaseId:existing.id});

  const split = splitRecord(row.price, env.PAID_CONTENT_COMMISSION_BPS, row.currency);
  const ref = reference();
  let purchaseId: string;
  if (existing) {
    const claimed = await prisma.paidContentPurchase.updateMany({
      where:{id:existing.id,status:'FAILED'},
      data:{status:'PENDING',attempts:{increment:1},reference:ref,externalRef:null,paidAt:null,reviewReason:null,providerPayload:Prisma.DbNull,...split,operator:input.operator,payerPhoneHint:input.phone.slice(-4),initiatedAt:new Date()}
    });
    if (claimed.count!==1) throw conflict('PAYMENT_IN_PROGRESS','Un paiement est déjà en cours');
    purchaseId=existing.id;
  } else {
    try {
      purchaseId=(await prisma.paidContentPurchase.create({data:{contentType:kind,contentId,buyerId:user.id,creatorId:row.authorId,...split,reference:ref,operator:input.operator,payerPhoneHint:input.phone.slice(-4)}})).id;
    } catch { throw conflict('PAYMENT_IN_PROGRESS','Un paiement est déjà en cours'); }
  }

  let result;
  try { result=await payments.initiate({reference:ref,amount:split.grossAmount,currency:row.currency,operator:input.operator,phone:input.phone,description:'Contenu payant Face to Face'}); }
  catch(e){ await prisma.paidContentPurchase.updateMany({where:{id:purchaseId,status:'PENDING'},data:{status:'FAILED'}}); throw e; }
  if(result.status==='REJECTED'){
    await prisma.paidContentPurchase.updateMany({where:{id:purchaseId,status:'PENDING'},data:{status:'FAILED',reviewReason:result.code}});
    throw new AppError(402,'PAYMENT_FAILED',result.message||'Le paiement a été refusé',{code:result.code});
  }
  if(result.status==='ACCEPTED'&&result.providerRef) await prisma.paidContentPurchase.updateMany({where:{id:purchaseId,status:'PENDING'},data:{externalRef:result.providerRef}});
  const now=await prisma.paidContentPurchase.findUniqueOrThrow({where:{id:purchaseId}});
  const content=await serializeOne(kind,row,user);
  if(now.status==='PAID') return {httpStatus:200 as const,status:'PAID' as const,alreadyPurchased:false,content};
  return {httpStatus:202 as const,status:'PENDING' as const,purchase:{id:now.id,status:now.status,amount:now.grossAmount,currency:now.currency,method:now.operator},content};
}
