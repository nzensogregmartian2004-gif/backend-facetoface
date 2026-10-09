import type { User } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authed, requireAuth } from '../../middleware/auth';
import { reportLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { badRequest, forbidden, notFound } from '../../utils/errors';
import { body } from '../../utils/validate';
import { loadVisible } from '../content/access';
import type { Kind } from '../content/types';

export const moderationRouter = Router();
moderationRouter.use(requireAuth);

const reportSchema = z.object({
  targetType: z.enum(['USER', 'GROUP', 'VIDEO', 'SHORT', 'LIVE', 'COMMENT', 'MESSAGE', 'PAID_CONTENT']),
  targetId: z.string().min(1).max(64),
  reason: z.enum(['SPAM', 'HARASSMENT', 'HATE', 'NUDITY', 'VIOLENCE', 'SCAM', 'IMPERSONATION', 'MINOR_SAFETY', 'OTHER']),
  details: z.string().trim().max(500, '500 caractères maximum').optional(),
});

/**
 * Vérifie que la cible existe ET que le signalant a le droit de la voir (on ne signale pas ce qu'on ne peut pas consulter,
 * et on ne révèle pas l'existence d'un contenu privé). Types acceptés : USER (étape 2), VIDEO, SHORT, COMMENT (étape 3).
 * LIVE, MESSAGE, PAID_CONTENT : à ajouter avec leurs modules (étapes 5, 10, 7+).
 */
async function assertReportable(me: User, type: string, id: string) {
  const self = () => badRequest('CANNOT_TARGET_SELF', 'Vous ne pouvez pas signaler votre propre contenu');
  if (type === 'USER') {
    if (id === me.id) throw badRequest('CANNOT_TARGET_SELF', 'Vous ne pouvez pas vous signaler vous-même');
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!target || target.status === 'DELETED') throw notFound('Utilisateur introuvable');
    return;
  }
  if (type === 'GROUP') {
    const group = await prisma.conversation.findUnique({ where: { id }, select: { id: true, isGroup: true, members: { select: { userId: true } } } });
    if (!group?.isGroup || !group.members.some((m) => m.userId === me.id)) throw notFound('Groupe introuvable');
    return;
  }
  if (type === 'VIDEO' || type === 'SHORT') {
    const row = await loadVisible(me, type as Kind, id);
    if (row.authorId === me.id) throw self();
    if (row.status !== 'PUBLISHED') throw notFound('Contenu introuvable');
    return;
  }
  if (type === 'MESSAGE') {
    const message = await prisma.message.findUnique({ where:{id}, include:{conversation:{include:{members:true}}} });
    const member = message?.conversation.members.find(m=>m.userId===me.id);
    if (!message || message.deletedAt || !member || (member.clearedAt && message.createdAt <= member.clearedAt)) throw notFound('Message introuvable');
    if (message.senderId===me.id) throw self();
    if (message.viewOnce) throw forbidden('VIEW_ONCE_NOT_REPORTABLE', 'Un message à vue unique ne peut pas être signalé');
    return;
  }
  if (type === 'LIVE') {
    const live = await prisma.live.findUnique({ where: { id }, select: { id: true, hostId: true, status: true, moderationStatus: true } });
    if (!live || live.moderationStatus === 'REMOVED' || live.status === 'CANCELLED') throw notFound('Live introuvable');
    if (live.hostId === me.id) throw self();
    return;
  }
  if (type === 'PAID_CONTENT') {
    const [video, short] = await Promise.all([
      prisma.video.findUnique({ where: { id }, select: { id: true, subscriptionOnly: true, status: true, authorId: true } }),
      prisma.short.findUnique({ where: { id }, select: { id: true, subscriptionOnly: true, status: true, authorId: true } }),
    ]);
    const target = video?.subscriptionOnly ? video : short?.subscriptionOnly ? short : null;
    if (!target || target.status !== 'PUBLISHED') throw notFound('Contenu payant introuvable');
    if (target.authorId === me.id) throw self();
    return;
  }
  if (type === 'COMMENT') {
    const c = await prisma.comment.findUnique({ where: { id } });
    if (!c || c.deletedAt) throw notFound('Commentaire introuvable');
    const parent = await loadVisible(me, c.targetType as Kind, c.targetId); // 404 si le contenu parent est invisible pour le signalant
    if (parent.status !== 'PUBLISHED') throw notFound('Commentaire introuvable');
    if (c.authorId === me.id) throw self();
    return;
  }
  throw badRequest('TARGET_TYPE_NOT_SUPPORTED', 'Ce type de contenu ne peut pas encore être signalé');
}

moderationRouter.post('/reports', reportLimiter, wrap(async (req, res) => {
  const b = body(reportSchema, req);
  const me = authed(req).user;
  await assertReportable(me, b.targetType, b.targetId);
  const existing = await prisma.report.findFirst({ where: { reporterId: me.id, targetType: b.targetType, targetId: b.targetId, status: { in: ['OPEN', 'REVIEWING'] } } });
  if (existing) return res.json({ report: { id: existing.id, status: existing.status } });
  const r = await prisma.report.create({ data: { reporterId: me.id, targetType: b.targetType, targetId: b.targetId, reason: b.reason, details: b.details || null } });
  res.status(201).json({ report: { id: r.id, status: r.status } });
}));
