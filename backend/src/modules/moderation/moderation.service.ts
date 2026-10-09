import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { forbidden, badRequest, notFound } from '../../utils/errors';
import { requirePermission } from '../admin/roles';
import type { AdminPermission } from '../admin/permissions';

export type ModerationTarget = 'USER'|'GROUP'|'VIDEO'|'SHORT'|'LIVE'|'COMMENT'|'MESSAGE'|'PAID_CONTENT';
export type ModerationAction = 'WARNING'|'HIDE'|'UNHIDE'|'REMOVE'|'RESTORE'|'SUSPEND'|'BAN'|'UNSUSPEND'|'UNBAN'|'DISABLE_MONETIZATION'|'ENABLE_MONETIZATION';

function assertAdmin(user: User, p: AdminPermission) {
  requirePermission(user, p);
}

const reasonRequired = (reason?: string) => {
  const value = reason?.trim();
  if (!value) throw badRequest('REASON_REQUIRED', 'Une raison est obligatoire pour une action de modération');
  return value;
};

function targetField(type: ModerationTarget, id: string): Prisma.ModerationActionCreateInput {
  const base: any = { targetType: type, targetId: id };
  if (type === 'USER') base.targetUser = { connect: { id } };
  if (type === 'GROUP') base.targetConversation = { connect: { id } };
  if (type === 'VIDEO' || type === 'PAID_CONTENT') base.targetVideo = { connect: { id } };
  if (type === 'SHORT') base.targetShort = { connect: { id } };
  if (type === 'LIVE') base.targetLive = { connect: { id } };
  if (type === 'COMMENT') base.targetComment = { connect: { id } };
  if (type === 'MESSAGE') base.targetMessage = { connect: { id } };
  return base;
}

async function assertTarget(type: ModerationTarget, id: string) {
  if (type === 'USER') {
    const row = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!row) throw notFound('Utilisateur introuvable');
    return row;
  }
  if (type === 'GROUP') {
    const row = await prisma.conversation.findUnique({ where: { id }, select: { id: true, isGroup: true } });
    if (!row?.isGroup) throw notFound('Groupe introuvable');
    return row;
  }
  if (type === 'VIDEO') {
    const row = await prisma.video.findUnique({ where: { id }, select: { id: true, status: true, authorId: true } });
    if (!row) throw notFound('Vidéo introuvable');
    return row;
  }
  if (type === 'SHORT') {
    const row = await prisma.short.findUnique({ where: { id }, select: { id: true, status: true, authorId: true } });
    if (!row) throw notFound('Short introuvable');
    return row;
  }
  if (type === 'LIVE') {
    const row = await prisma.live.findUnique({ where: { id }, select: { id: true, moderationStatus: true, hostId: true } });
    if (!row) throw notFound('Live introuvable');
    return row;
  }
  if (type === 'COMMENT') {
    const row = await prisma.comment.findUnique({ where: { id }, select: { id: true, moderationStatus: true, authorId: true } });
    if (!row) throw notFound('Commentaire introuvable');
    return row;
  }
  if (type === 'MESSAGE') {
    const row = await prisma.message.findUnique({ where: { id }, select: { id: true, moderationStatus: true, senderId: true } });
    if (!row) throw notFound('Message introuvable');
    return row;
  }
  // PAID_CONTENT is represented by a paywalled Video/Short in the current data model.
  const [video, short] = await Promise.all([
    prisma.video.findUnique({ where: { id }, select: { id: true, subscriptionOnly: true, status: true, authorId: true } }),
    prisma.short.findUnique({ where: { id }, select: { id: true, subscriptionOnly: true, status: true, authorId: true } }),
  ]);
  if (video?.subscriptionOnly) return { ...video, underlying: 'VIDEO' as const };
  if (short?.subscriptionOnly) return { ...short, underlying: 'SHORT' as const };
  throw notFound('Contenu payant introuvable');
}

export async function moderate(admin: User, type: ModerationTarget, id: string, action: ModerationAction, reason: string, reportId?: string) {
  assertAdmin(admin, 'moderation.content.moderate');
  const why = reasonRequired(reason);
  const target: any = await assertTarget(type, id);
  if (type === 'USER' && ['SUSPEND','BAN'].includes(action) && target.id === admin.id) throw badRequest('CANNOT_MODERATE_SELF', 'Un administrateur ne peut pas se sanctionner lui-même');
  if (type === 'USER' && target.status === 'DELETED' && ['UNSUSPEND','UNBAN','ENABLE_MONETIZATION'].includes(action)) throw badRequest('DELETED_ACCOUNT_IMMUTABLE', 'Un compte supprimé et anonymisé ne peut pas être réactivé');
  if (type !== 'USER' && ['SUSPEND','BAN','UNSUSPEND','UNBAN','DISABLE_MONETIZATION','ENABLE_MONETIZATION'].includes(action)) throw badRequest('ACTION_NOT_ALLOWED', 'Cette action ne s’applique pas à cette cible');

  return prisma.$transaction(async tx => {
    let metadata: Record<string, unknown> = {};
    if (type === 'USER') {
      if (action === 'HIDE' || action === 'UNHIDE') {
        await tx.user.update({ where: { id }, data: { profileModerationStatus: action === 'HIDE' ? 'HIDDEN' : 'ACTIVE' } });
      } else if (action === 'DISABLE_MONETIZATION' || action === 'ENABLE_MONETIZATION') {
        await tx.user.update({ where: { id }, data: { monetizationDisabledAt: action === 'DISABLE_MONETIZATION' ? new Date() : null, monetizationDisabledReason: action === 'DISABLE_MONETIZATION' ? why : null } });
      } else if (action === 'SUSPEND' || action === 'BAN' || action === 'UNSUSPEND' || action === 'UNBAN') {
        const next = action === 'SUSPEND' ? 'SUSPENDED' : action === 'BAN' ? 'BANNED' : 'ACTIVE';
        await tx.user.update({ where: { id }, data: { status: next } });
      } else if (action !== 'WARNING') {
        throw badRequest('ACTION_NOT_ALLOWED', 'Action utilisateur invalide');
      }
      metadata = { previousStatus: target.status, action };
    } else if (type === 'VIDEO' || type === 'SHORT') {
      const model: any = type === 'VIDEO' ? tx.video : tx.short;
      const next = action === 'HIDE' ? 'HIDDEN' : action === 'REMOVE' ? 'REMOVED' : action === 'UNHIDE' || action === 'RESTORE' ? 'PUBLISHED' : null;
      if (!next) throw badRequest('ACTION_NOT_ALLOWED', 'Action de contenu invalide');
      await model.update({ where: { id }, data: { status: next, ...(next === 'PUBLISHED' ? { publishedAt: new Date() } : {}) } });
      metadata = { previousStatus: target.status, nextStatus: next };
    } else if (type === 'LIVE') {
      const next = action === 'HIDE' ? 'HIDDEN' : action === 'REMOVE' ? 'REMOVED' : action === 'UNHIDE' || action === 'RESTORE' ? 'ACTIVE' : null;
      if (!next) throw badRequest('ACTION_NOT_ALLOWED', 'Action Live invalide');
      await tx.live.update({ where: { id }, data: { moderationStatus: next } });
      metadata = { previousStatus: target.moderationStatus, nextStatus: next };
    } else if (type === 'COMMENT') {
      const next = action === 'HIDE' ? 'HIDDEN' : action === 'REMOVE' ? 'REMOVED' : action === 'UNHIDE' || action === 'RESTORE' ? 'ACTIVE' : null;
      if (!next) throw badRequest('ACTION_NOT_ALLOWED', 'Action commentaire invalide');
      await tx.comment.update({ where: { id }, data: { moderationStatus: next } });
      metadata = { previousStatus: target.moderationStatus, nextStatus: next };
    } else if (type === 'MESSAGE') {
      const next = action === 'HIDE' ? 'HIDDEN' : action === 'REMOVE' ? 'REMOVED' : action === 'UNHIDE' || action === 'RESTORE' ? 'ACTIVE' : null;
      if (!next) throw badRequest('ACTION_NOT_ALLOWED', 'Action message invalide');
      await tx.message.update({ where: { id }, data: { moderationStatus: next } });
      metadata = { previousStatus: target.moderationStatus, nextStatus: next };
    } else {
      const underlying = target.underlying as 'VIDEO'|'SHORT';
      const model: any = underlying === 'VIDEO' ? tx.video : tx.short;
      const next = action === 'HIDE' ? 'HIDDEN' : action === 'REMOVE' ? 'REMOVED' : action === 'UNHIDE' || action === 'RESTORE' ? 'PUBLISHED' : null;
      if (!next) throw badRequest('ACTION_NOT_ALLOWED', 'Action contenu payant invalide');
      await model.update({ where: { id }, data: { status: next, ...(next === 'PUBLISHED' ? { publishedAt: new Date() } : {}) } });
      metadata = { underlying, previousStatus: target.status, nextStatus: next };
    }

    const targetData: any = targetField(type, id);
    if (type === 'PAID_CONTENT' && target.underlying === 'SHORT') { delete targetData.targetVideo; targetData.targetShort = { connect: { id } }; }
    const actionRow = await tx.moderationAction.create({ data: { ...targetData, adminId: admin.id, action, reason: why, reportId: reportId || null, metadata } });
    await tx.adminAuditLog.create({ data: { adminId: admin.id, action: `MODERATION_${action}`, targetType: type, targetId: id, reason: why, metadata: { ...metadata, reportId: reportId || null } } });
    if (reportId) {
      await tx.report.update({ where: { id: reportId }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    }
    return actionRow;
  });
}

export async function listActions(admin: User, input: { targetType?: ModerationTarget; targetId?: string; limit: number }) {
  assertAdmin(admin, 'moderation.reports.view');
  return prisma.moderationAction.findMany({ where: { ...(input.targetType ? { targetType: input.targetType } : {}), ...(input.targetId ? { targetId: input.targetId } : {}) }, orderBy: { createdAt: 'desc' }, take: input.limit });
}
