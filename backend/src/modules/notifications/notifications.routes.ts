import { Router } from 'express';
import { requireAuth, authed } from '../../middleware/auth';
import { prisma } from '../../config/db';
import { wrap } from '../../utils/async';
import { notFound } from '../../utils/errors';
import { blockedIdsFor } from '../content/access';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', wrap(async (req, res) => {
  const userId = authed(req).user.id;
  const blocked = await blockedIdsFor(userId);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const rows = await prisma.notification.findMany({ where: { userId, ...(blocked.length ? { NOT:{ actorId:{ in:blocked } } } : {}) }, orderBy: [{ createdAt:'desc' }, { id:'desc' }], take: limit + 1, include:{ actor:{select:{id:true,username:true,displayName:true,avatarUrl:true}} } });
  const page = rows.slice(0,limit);
  res.json({ items: page.map(n => ({ id:n.id,type:n.type,actorId:n.actorId,targetType:n.targetType,targetId:n.targetId,count:n.count,amountFcfa:n.amountFcfa,readAt:n.readAt,read:n.readAt!==null,createdAt:n.createdAt,actor:n.actor })), nextCursor: rows.length>limit ? rows[limit-1].id : null });
}));
notificationsRouter.get('/unread-count', wrap(async (req, res) => {
  const userId=authed(req).user.id; const blocked=await blockedIdsFor(userId);
  res.json({ count: await prisma.notification.count({ where: { userId, readAt:null, ...(blocked.length ? { NOT:{actorId:{in:blocked}} } : {}) } }) });
}));
notificationsRouter.post('/:id/read', wrap(async (req, res) => {
  const r=await prisma.notification.updateMany({ where:{id:String(req.params.id),userId:authed(req).user.id},data:{readAt:new Date()} });
  if (!r.count) throw notFound('Notification introuvable');
  res.status(204).end();
}));
notificationsRouter.post('/read-all', wrap(async (req, res) => { await prisma.notification.updateMany({where:{userId:authed(req).user.id,readAt:null},data:{readAt:new Date()}}); res.status(204).end(); }));
