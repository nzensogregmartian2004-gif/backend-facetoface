import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { messageLimiter, unlockLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import { editMessageSchema, inboxQuerySchema, mediaUrlSchema, messagesQuerySchema, openConversationSchema, sendMessageSchema, unlockSchema, reactionSchema, disappearingSchema, muteSchema, starSchema, archiveSchema } from './messages.schemas';
import * as svc from './messages.service';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

messagesRouter.get('/settings', wrap(async (_req, res) => { res.json(await svc.settings()); }));

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
/** POST /api/messages/messages/:id/open — ouverture UNIQUE d'un message à vue unique par le destinataire. 410 si déjà ouvert ; le contenu n'est renvoyé que ici. */
messagesRouter.post('/messages/:id/open', messageLimiter, wrap(async (req, res) => { res.json(await svc.openViewOnce(me(req), id(req))); }));
/** POST /api/messages/:id/unlock { operator, phone } — 200 si déjà acheté ; 202 si le paiement Mobile Money est lancé (résultat par webhook). */
messagesRouter.post('/:id/unlock', unlockLimiter, wrap(async (req, res) => {
  const { httpStatus, ...payload } = await svc.unlockMessage(me(req), id(req), body(unlockSchema, req));
  res.status(httpStatus).json(payload);
}));
messagesRouter.post('/conversations/:id/search', wrap(async (req, res) => { const q = String(req.body?.q ?? ''); const limit = Math.min(Math.max(Number(req.body?.limit ?? 50), 1), 100); res.json(await svc.searchMessages(me(req), id(req), q, { cursor: req.body?.cursor, limit })); }));
messagesRouter.post('/conversations/:id/mute', wrap(async (req, res) => { res.json(await svc.setMute(me(req), id(req), body(muteSchema, req).seconds)); }));
messagesRouter.post('/conversations/:id/disappearing', wrap(async (req, res) => { res.json(await svc.setDisappearing(me(req), id(req), body(disappearingSchema, req).seconds)); }));
messagesRouter.post('/conversations/:id/lock', wrap(async (req, res) => { const locked = Boolean((req.body as any)?.locked); res.json(await svc.setChatLock(me(req), id(req), locked)); }));
messagesRouter.get('/conversations/:id/export', wrap(async (req, res) => { res.json(await svc.exportConversation(me(req), id(req))); }));
messagesRouter.post('/messages/:id/reaction', wrap(async (req, res) => { res.json(await svc.reactToMessage(me(req), id(req), body(reactionSchema, req).emoji)); }));
messagesRouter.post('/messages/:id/edit', wrap(async (req, res) => { res.json({ message: await svc.editMessage(me(req), id(req), body(editMessageSchema, req).text) }); }));
messagesRouter.post('/messages/:id/pin', wrap(async (req, res) => { res.json(await svc.pinMessage(me(req), id(req))); }));
messagesRouter.post('/conversations/:id/reply/:messageId', wrap(async (req, res) => { res.json({ message: (await svc.replyMessage(me(req), id(req), String(req.params.messageId), body(sendMessageSchema, req))).message }); }));
messagesRouter.post('/messages/:id/forward', wrap(async (req, res) => { const targetConversationId = String((req.body as any)?.targetConversationId ?? ''); if (!targetConversationId) throw new Error('targetConversationId requis'); res.json({ message: await svc.forwardMessage(me(req), id(req), targetConversationId) }); }));
messagesRouter.delete('/:id', wrap(async (req, res) => { await svc.deleteMessage(me(req), id(req)); res.status(204).end(); }));
/** GET /api/messages/starred?conversationId= — messages favoris (de toutes les conversations, ou d'une seule). */
messagesRouter.get('/starred', wrap(async (req, res) => { res.json(await svc.listStarred(me(req), { conversationId: typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined, limit: 50 })); }));
/** POST /api/messages/messages/:id/star — { starred } : ajoute ou retire le favori. */
messagesRouter.post('/messages/:id/star', messageLimiter, wrap(async (req, res) => { res.json(await svc.setStarred(me(req), id(req), body(starSchema, req).starred)); }));
/** POST /api/messages/messages/:id/hide-for-me — « supprimer pour moi » : retire le message de ma vue seulement. */
messagesRouter.post('/messages/:id/hide-for-me', messageLimiter, wrap(async (req, res) => { await svc.hideForMe(me(req), id(req)); res.status(204).end(); }));
/** POST /api/messages/conversations/:id/archive — { archived } : archive ou désarchive la conversation pour moi. */
messagesRouter.post('/conversations/:id/archive', wrap(async (req, res) => { res.json(await svc.setArchived(me(req), id(req), body(archiveSchema, req).archived)); }));
