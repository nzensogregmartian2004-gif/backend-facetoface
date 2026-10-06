import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { unlockLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import { pageQuerySchema } from '../content/content.schemas';
import { callSettingsSchema, disputeSchema, requestCallSchema } from './calls.schemas';
import * as svc from './calls.service';

export const callsRouter = Router();
callsRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

callsRouter.get('/settings', wrap(async (_req, res) => { res.json(svc.settings()); }));
callsRouter.get('/me/settings', wrap(async (req, res) => { res.json(await svc.getMySettings(me(req))); }));
callsRouter.put('/me/settings', wrap(async (req, res) => { res.json(await svc.updateMySettings(me(req), body(callSettingsSchema, req))); }));
callsRouter.get('/incoming', wrap(async (req, res) => { res.json(await svc.incomingCalls(me(req))); }));
callsRouter.get('/creators/:userId/offer', wrap(async (req, res) => { res.json(await svc.getOffer(me(req), String(req.params.userId))); }));

callsRouter.get('/', wrap(async (req, res) => { res.json(await svc.listCalls(me(req), parse(pageQuerySchema, req.query))); }));
/** POST /api/calls { calleeId, type, minutes?, operator, phone } — 202 si le paiement Mobile Money est lancé (résultat par webhook), 200 s'il est déjà confirmé. */
callsRouter.post('/', unlockLimiter, wrap(async (req, res) => {
  const { httpStatus, ...payload } = await svc.requestCall(me(req), body(requestCallSchema, req));
  res.status(httpStatus).json(payload);
}));
callsRouter.get('/:id', wrap(async (req, res) => { res.json(await svc.getCall(me(req), id(req))); }));
callsRouter.post('/:id/accept', wrap(async (req, res) => { res.json(await svc.acceptCall(me(req), id(req))); }));
callsRouter.post('/:id/decline', wrap(async (req, res) => { res.json(await svc.declineCall(me(req), id(req))); }));
callsRouter.post('/:id/cancel', wrap(async (req, res) => { res.json(await svc.cancelCall(me(req), id(req))); }));
callsRouter.post('/:id/end', wrap(async (req, res) => { res.json(await svc.endCall(me(req), id(req))); }));
callsRouter.post('/:id/token', wrap(async (req, res) => { res.json(await svc.callToken(me(req), id(req))); }));
callsRouter.post('/:id/dispute', wrap(async (req, res) => { res.json(await svc.disputeCall(me(req), id(req), body(disputeSchema, req).reason)); }));
