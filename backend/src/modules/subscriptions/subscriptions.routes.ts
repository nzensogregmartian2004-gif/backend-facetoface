import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { paymentLimiter } from '../../middleware/rateLimit';
import { body } from '../../utils/validate';
import { planSchema, subscribeSchema } from './subscriptions.schemas';
import * as svc from './subscriptions.service';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

subscriptionsRouter.get('/creators/:id/plan', wrap(async (req, res) => res.json(await svc.getPlan(me(req), id(req)))));
subscriptionsRouter.get('/me/plan', wrap(async (req, res) => res.json(await svc.getMyPlan(me(req)))));
subscriptionsRouter.put('/me/plan', wrap(async (req, res) => res.json(await svc.updateMyPlan(me(req), body(planSchema, req)))));
subscriptionsRouter.get('/creators/:id/me', wrap(async (req, res) => res.json(await svc.getMySubscription(me(req), id(req)))));
subscriptionsRouter.post('/creators/:id', paymentLimiter, wrap(async (req, res) => { const r = await svc.subscribe(me(req), id(req), body(subscribeSchema, req)); res.status(r.httpStatus).json({ subscription: r.subscription, payment: r.payment }); }));
subscriptionsRouter.post('/creators/:id/cancel', wrap(async (req, res) => res.json(await svc.cancel(me(req), id(req)))));
