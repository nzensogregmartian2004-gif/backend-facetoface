import { Router } from 'express';
import { requireAuth, authed } from '../../middleware/auth';
import { prisma } from '../../config/db';
import { wrap } from '../../utils/async';
import { notFound } from '../../utils/errors';
import { blockedIdsFor } from '../content/access';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.post('/devices', wrap(async (req, res) => {
  const userId = authed(req).user.id;
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const platform = req.body?.platform === 'ios' ? 'ios' : req.body?.platform === 'android' ? 'android' : '';
  if (!token || token.length > 512 || !platform) return res.status(400).json({ code: 'INVALID_DEVICE', message: 'Appareil invalide' });
  const device = await prisma.pushDevice.upsert({
    where: { token },
    create: { userId, token, platform, active: true },
    update: { userId, platform, active: true, lastSeenAt: new Date() },
  });
  res.status(204).end();
}));

notificationsRouter.delete('/devices', wrap(async (req, res) => {
  const userId = authed(req).user.id;
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ code: 'INVALID_DEVICE', message: 'Jeton invalide' });
  await prisma.pushDevice.updateMany({ where: { token, userId }, data: { active: false } });
  res.status(204).end();
}));

notificationsRouter.get('/', wrap(async (req, res) => {
  const userId = authed(req).user.id;
  const blocked = await blockedIdsFor(userId);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const rows = await prisma.notification.findMany({ where: { userId, ...(blocked.length ? { NOT:{ actorId:{ in:blocked } } } : {}) }, orderBy: [{ createdAt:'desc' }, { id:'desc' }], take: limit + 1, include:{ actor:{select:{id:true,username:true,displayName:true,avatarUrl:true}} } });
  const page = rows.slice(0,limit);
  res.json({ items: page.map(n => ({ id:n.id,type:n.type,actorId:n.actorId,targetType:n.targetType,targetId:n.targetId,count:n.count,amount:n.amount,currency:n.currency,readAt:n.readAt,read:n.readAt!==null,createdAt:n.createdAt,actor:n.actor })), nextCursor: rows.length>limit ? rows[limit-1].id : null });
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
