import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { messageLimiter, unlockLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import { inboxQuerySchema, mediaUrlSchema, messagesQuerySchema, openConversationSchema, sendMessageSchema, unlockSchema } from './messages.schemas';
import * as svc from './messages.service';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

messagesRouter.get('/settings', wrap(async (_req, res) => { res.json(svc.settings()); }));

messagesRouter.get('/conversations', wrap(async (req, res) => { res.json(await svc.listConversations(me(req), parse(inboxQuerySchema, req.query))); }));
messagesRouter.get('/conversations/unread-count', wrap(async (req, res) => { res.json({ count: await svc.unreadConversations(me(req)) }); }));
messagesRouter.post('/conversations', messageLimiter, wrap(async (req, res) => { res.json(await svc.openConversation(me(req), body(openConversationSchema, req).userId)); }));
messagesRouter.get('/conversations/:id', wrap(async (req, res) => { res.json(await svc.getConversation(me(req), id(req))); }));
messagesRouter.delete('/conversations/:id', wrap(async (req, res) => { await svc.hideConversation(me(req), id(req)); res.status(204).end(); }));
messagesRouter.post('/conversations/:id/read', wrap(async (req, res) => { await svc.markRead(me(req), id(req)); res.status(204).end(); }));
messagesRouter.get('/conversations/:id/messages', wrap(async (req, res) => { res.json(await svc.listMessages(me(req), id(req), parse(messagesQuerySchema, req.query))); }));
messagesRouter.post('/conversations/:id/messages', messageLimiter, wrap(async (req, res) => {
  const r = await svc.sendMessage(me(req), id(req), body(sendMessageSchema, req));
  res.status(r.created ? 201 : 200).json({ message: r.message });
}));

messagesRouter.post('/upload-url', uploadLimiter, wrap(async (req, res) => { res.json(await svc.requestMediaUpload(me(req), body(mediaUrlSchema, req))); }));
messagesRouter.get('/purchases/:id', wrap(async (req, res) => { res.json(await svc.getPurchase(me(req), id(req))); }));
/** POST /api/messages/:id/unlock { operator, phone } — 200 si déjà acheté ; 202 si le paiement Mobile Money est lancé (résultat par webhook). */
messagesRouter.post('/:id/unlock', unlockLimiter, wrap(async (req, res) => {
  const { httpStatus, ...payload } = await svc.unlockMessage(me(req), id(req), body(unlockSchema, req));
  res.status(httpStatus).json(payload);
}));
messagesRouter.delete('/:id', wrap(async (req, res) => { await svc.deleteMessage(me(req), id(req)); res.status(204).end(); }));
