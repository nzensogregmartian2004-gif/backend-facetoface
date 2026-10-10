import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { permissionGuard } from '../admin/roles';
import * as svc from './support.service';
import { adminTicketQuerySchema, createTicketSchema, replySchema, ticketStatusChangeSchema } from './support.schemas';

const me = (req: Parameters<typeof authed>[0]) => authed(req).user;

/** Côté utilisateur : ouvrir un ticket, lire les siens, répondre. Aucune permission d'administration. */
export const supportRouter = Router();
supportRouter.use(requireAuth);
supportRouter.post('/tickets', wrap(async (req, res) => {
  res.status(201).json({ ticket: await svc.openTicket(me(req).id, parse(createTicketSchema, req.body)) });
}));
supportRouter.get('/tickets', wrap(async (req, res) => res.json({ tickets: await svc.listOwnTickets(me(req).id) })));
supportRouter.get('/tickets/:id', wrap(async (req, res) => res.json({ ticket: await svc.getOwnTicket(me(req).id, String(req.params.id)) })));
supportRouter.post('/tickets/:id/messages', wrap(async (req, res) => {
  const b = parse(replySchema, req.body);
  res.status(201).json({ ticket: await svc.replyAsUser(me(req).id, String(req.params.id), b.body) });
}));

/**
 * Côté équipe, monté sous /api/admin : la garde gateAdminRoute vérifie d'abord la permission de la route
 * (voir permissionForAdminPath) ; permissionGuard la redemande ici, par sécurité.
 */
export const supportAdminRouter = Router();
supportAdminRouter.use(requireAuth);
supportAdminRouter.get('/tickets', permissionGuard('support.tickets.view'), wrap(async (req, res) => {
  const q = parse(adminTicketQuerySchema, req.query);
  res.json({ tickets: await svc.listTickets({ status: q.status, category: q.category, limit: q.limit }) });
}));
supportAdminRouter.get('/tickets/:id', permissionGuard('support.tickets.view'), wrap(async (req, res) => {
  res.json({ ticket: await svc.getTicket(String(req.params.id)) });
}));
supportAdminRouter.post('/tickets/:id/messages', permissionGuard('support.tickets.reply'), wrap(async (req, res) => {
  const b = parse(replySchema, req.body);
  res.status(201).json({ ticket: await svc.adminReply(me(req).id, String(req.params.id), b.body) });
}));
supportAdminRouter.patch('/tickets/:id/status', permissionGuard('support.tickets.status'), wrap(async (req, res) => {
  const b = parse(ticketStatusChangeSchema, req.body);
  res.json({ ticket: await svc.setTicketStatus(me(req).id, String(req.params.id), b.status, b.reason) });
}));
