import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';

import { can, isStaffAccount, requirePermission, requireSuperAdmin } from './roles';
import { redactRevenue } from './revenue';
import type { AdminCandidate } from './permissions';
function assertAdmin(user: AdminCandidate) { requirePermission(user, 'admin.access'); }

export async function audit(adminId: string, action: string, targetType: string, targetId: string, reason?: string, metadata?: unknown) {
  await prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, reason: reason || null, metadata: metadata == null ? undefined : JSON.parse(JSON.stringify(metadata)) } });
}

export async function dashboard(user: User) {
  assertAdmin(user);
  const [users, creators, videos, shorts, views, lives, transactions, transactionTotals, ads, premium, withdrawals, reports] = await Promise.all([
    prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.user.count({ where: { isCreator: true, status: { not: 'DELETED' } } }),
    prisma.video.count(),
    prisma.short.count(),
    prisma.contentView.count(),
    prisma.live.count(),
    prisma.financialTransaction.count(),
    prisma.financialTransaction.groupBy({ by: ['currency'], where: { status: { in: ['PAID','COMPLETED'] } }, _sum: { grossAmount: true, platformFeeAmount: true, creatorAmount: true } }),
    prisma.advertisingCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.premiumSubscription.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.withdrawal.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true, fee: true } }),
    prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const revenue = redactRevenue(can(user, 'finance.revenue.view'), transactionTotals, withdrawals);
  return { users, creators, content: { videos, shorts, lives, views }, transactions: { count: transactions, totals: revenue.totals }, advertising: ads, premium, withdrawals: revenue.withdrawals, reports };
}

export async function searchUsers(admin: User, input: any) {
  assertAdmin(admin); const { q, status, isCreator, page, limit } = input;
  const where: any = { ...(status ? { status } : {}), ...(isCreator === undefined ? {} : { isCreator }) };
  if (q) where.OR = [{ username: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, select: { id:true, username:true, displayName:true, email:true, status:true, isCreator:true, country:true, preferredLanguage:true, preferredCurrency:true, createdAt:true, lastLoginAt:true }, orderBy:{createdAt:'desc'}, skip:(page-1)*limit, take:limit }),
    prisma.user.count({ where }),
  ]); return { items, page, limit, total, pages: Math.ceil(total/limit) };
}

const safeUserSelect = { id:true, username:true, displayName:true, email:true, avatarUrl:true, bio:true, country:true, birthDate:true, status:true, fraudStatus:true, fraudScore:true, fraudFlaggedAt:true, emailVerifiedAt:true, isCreator:true, creatorActivatedAt:true, profileVisibility:true, allowMessagesFrom:true, showOnlineStatus:true, preferredLanguage:true, preferredCurrency:true, failedLoginCount:true, lockedUntil:true, lastLoginAt:true, passwordChangedAt:true, deletedAt:true, createdAt:true, updatedAt:true } as const;

export async function getUser(admin: User, id: string) {
  assertAdmin(admin);
  const row = await prisma.user.findUnique({ where:{id}, select:{ ...safeUserSelect, monetizationEligibility:true } });
  if (!row) throw notFound('Utilisateur introuvable');
  return row;
}

export async function setUserStatus(admin: User, id: string, input: any) {
  requirePermission(admin, input?.status === 'ACTIVE' ? 'users.reactivate' : 'users.suspend');
  if (input?.status === 'BANNED' || input?.status === 'DELETED') requireSuperAdmin(admin);
  assertAdmin(admin);
  if (id === admin.id && input.status !== 'ACTIVE') throw badRequest('CANNOT_DISABLE_SELF', 'Un administrateur ne peut pas désactiver son propre compte');
  if (id !== admin.id && (await isStaffAccount(id))) throw forbidden('CANNOT_MODIFY_ADMIN', 'Un administrateur ne peut pas modifier le statut d’un autre administrateur');
  const existing = await prisma.user.findUnique({ where:{id}, select:{...safeUserSelect} });
  if (!existing) throw notFound('Utilisateur introuvable');
  if (existing.status === 'DELETED' && input.status === 'ACTIVE') throw badRequest('DELETED_ACCOUNT_IMMUTABLE', 'Un compte supprimé et anonymisé ne peut pas être réactivé');
  if (input.status === 'BANNED' && !input.reason) throw badRequest('REASON_REQUIRED', 'Une raison est obligatoire pour un bannissement');
  const updated = await prisma.$transaction(async tx => {
    const u = await tx.user.update({ where:{id}, data:{ status: input.status, deletedAt: input.status === 'DELETED' ? new Date() : existing.deletedAt } });
    await tx.adminAuditLog.create({ data:{ adminId:admin.id, action:'USER_STATUS_CHANGE', targetType:'USER', targetId:id, reason:input.reason||null, metadata:{from:existing.status,to:input.status} } });
    return u;
  });
  const { passwordHash: _passwordHash, ...safeUpdated } = updated;
  return safeUpdated;
}

export async function setContentStatus(admin: User, type: 'VIDEO'|'SHORT', id: string, input: any) {
  if (input?.status === 'REMOVED') requireSuperAdmin(admin);
  assertAdmin(admin); const model:any = type === 'VIDEO' ? prisma.video : prisma.short; const row = await model.findUnique({where:{id},select:{id:true,status:true}}); if (!row) throw notFound('Contenu introuvable');
  const updated = await prisma.$transaction(async tx => { const m:any = type === 'VIDEO' ? tx.video : tx.short; const u = await m.update({where:{id},data:{status:input.status, ...(input.status==='PUBLISHED'?{publishedAt:new Date()}:{}), removedAt: input.status==='REMOVED' ? new Date() : null}}); await tx.adminAuditLog.create({data:{adminId:admin.id,action:'CONTENT_STATUS_CHANGE',targetType:type,targetId:id,reason:input.reason||null,metadata:{from:row.status,to:input.status}}}); return u; }); return updated;
}

export async function listReports(admin: User, status?: string) { assertAdmin(admin); return prisma.report.findMany({ where: status ? { status: status as any } : {}, orderBy:{createdAt:'desc'}, take:200 }); }
export async function setReportStatus(admin: User, id: string, input: any) { assertAdmin(admin); return prisma.$transaction(async tx => { const row=await tx.report.findUnique({where:{id}}); if(!row) throw notFound('Signalement introuvable'); const updated=await tx.report.update({where:{id},data:{status:input.status,resolvedAt:['RESOLVED','DISMISSED'].includes(input.status)?new Date():null}}); await tx.adminAuditLog.create({data:{adminId:admin.id,action:'REPORT_STATUS_CHANGE',targetType:'REPORT',targetId:id,reason:input.reason||null,metadata:{from:row.status,to:input.status}}}); return updated; }); }

export async function listTransactions(admin: User, input: any) { assertAdmin(admin); return prisma.financialTransaction.findMany({where:{...(input.status?{status:input.status as any}:{}),...(input.currency?{currency:input.currency}:{})},orderBy:{createdAt:'desc'},take:input.limit}); }

export async function requestRefundReview(admin: User, id: string, reason: string) {
  assertAdmin(admin); const row=await prisma.financialTransaction.findUnique({where:{id}}); if(!row) throw notFound('Transaction introuvable'); if(row.status==='REFUNDED') throw badRequest('ALREADY_REFUNDED','Transaction déjà remboursée');
  return prisma.$transaction(async tx => { const updated=await tx.financialTransaction.update({where:{id},data:{status:'REVIEW',refundStatus:'REQUESTED',failureReason:null}}); await tx.adminAuditLog.create({data:{adminId:admin.id,action:'REFUND_REVIEW_REQUEST',targetType:'FINANCIAL_TRANSACTION',targetId:id,reason,metadata:{reference:row.reference}}}); return updated; });
}

export async function listWithdrawals(admin: User, status?: string) { assertAdmin(admin); return prisma.withdrawal.findMany({where:status?{status:status as any}: {},orderBy:{requestedAt:'desc'},take:200}); }

export async function setWithdrawalStatus(admin: User, id: string, input: any) {
  assertAdmin(admin);
  return prisma.$transaction(async tx => {
    const w=await tx.withdrawal.findUnique({where:{id}}); if(!w) throw notFound('Retrait introuvable');
    if (w.userId === admin.id) throw forbidden('CANNOT_PROCESS_OWN_WITHDRAWAL', 'Un administrateur ne peut pas traiter son propre retrait');
    if (await isStaffAccount(w.userId)) throw forbidden('CANNOT_PROCESS_ADMIN_WITHDRAWAL', 'Un administrateur ne peut pas traiter le retrait d’un autre administrateur');
    if(['COMPLETED','FAILED','CANCELLED'].includes(w.status)) throw badRequest('WITHDRAWAL_FINALIZED','Ce retrait est déjà finalisé');
    const target=input.status; const wallet=await tx.wallet.findUnique({where:{userId_currency:{userId:w.userId,currency:w.currency}}}); if(!wallet) throw notFound('Portefeuille introuvable');
    let walletUpdate:any={}; let ledgerType:any; let ledgerAmount=0; let description='';
    if(target==='COMPLETED') { if(w.status==='PROCESSING' || w.status==='REVIEW' || w.status==='PENDING') { walletUpdate={blockedAmount:{decrement:w.amount},withdrawnAmount:{increment:w.amount}}; ledgerType='WITHDRAWAL_COMPLETED'; description='Retrait traité par administration'; } }
    else if(target==='FAILED'||target==='CANCELLED') { walletUpdate={blockedAmount:{decrement:w.amount},availableAmount:{increment:w.amount}}; ledgerType='WITHDRAWAL_RELEASED'; ledgerAmount=w.amount; description='Réservation de retrait libérée'; }
    const updatedWallet=Object.keys(walletUpdate).length?await tx.wallet.update({where:{id:wallet.id},data:walletUpdate}):wallet;
    const updated=await tx.withdrawal.updateMany({where:{id,status:{in:['PENDING','REVIEW','PROCESSING']}},data:{status:target,externalReference:input.externalReference||undefined,failureReason:target==='FAILED'||target==='CANCELLED'?input.reason||null:null,processedAt:['COMPLETED','FAILED','CANCELLED'].includes(target)?new Date():null}});
    if (!updated.count) throw conflict('WITHDRAWAL_STATE_CHANGED', 'Le retrait a été traité par une autre opération');
    const updatedWithdrawal = await tx.withdrawal.findUniqueOrThrow({where:{id}});
    if(ledgerType) await tx.walletLedgerEntry.create({data:{walletId:wallet.id,userId:w.userId,type:ledgerType,amount:ledgerAmount,balanceAfter:updatedWallet.availableAmount,currency:w.currency,sourceType:'WITHDRAWAL_ADMIN',sourceId:w.id,description}});
    await tx.financialTransaction.update({where:{sourceType_sourceId:{sourceType:'WITHDRAWAL',sourceId:w.id}},data:{status:target==='COMPLETED'?'COMPLETED':target==='FAILED'?'FAILED':target==='CANCELLED'?'CANCELLED':'REVIEW',externalReference:input.externalReference||undefined,completedAt:target==='COMPLETED'?new Date():undefined,failureReason:(target==='FAILED'||target==='CANCELLED')?input.reason||undefined:undefined}});
    await tx.adminAuditLog.create({data:{adminId:admin.id,action:'WITHDRAWAL_STATUS_CHANGE',targetType:'WITHDRAWAL',targetId:id,reason:input.reason||null,metadata:{from:w.status,to:target,externalReference:input.externalReference||null}}});
    return {withdrawal:updatedWithdrawal,wallet:updatedWallet};
  });
}

export async function setFraudStatus(admin: User, id: string, status: 'CLEAR'|'REVIEW'|'BLOCKED', reason: string) { assertAdmin(admin); const row = await prisma.user.findUnique({ where:{id}, select:{id:true,fraudStatus:true} }); if(!row) throw notFound('Utilisateur introuvable'); const updated = await prisma.$transaction(async tx => { const u = await tx.user.update({where:{id},data:{fraudStatus:status, fraudScore:status==='CLEAR'?0:row.fraudStatus==='BLOCKED'?100:60,fraudFlaggedAt:status==='CLEAR'?null:new Date()}}); await tx.adminAuditLog.create({data:{adminId:admin.id,action:'FRAUD_STATUS_CHANGE',targetType:'USER',targetId:id,reason,metadata:{from:row.fraudStatus,to:status}}}); return u; }); return {id:updated.id,fraudStatus:updated.fraudStatus,fraudScore:updated.fraudScore,fraudFlaggedAt:updated.fraudFlaggedAt}; }
