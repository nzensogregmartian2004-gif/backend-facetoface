import { Router } from 'express';
import type { CallType } from '@prisma/client';
import { authed, requireAuth } from '../../middleware/auth';
import { paymentLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { badRequest } from '../../utils/errors';
import { body } from '../../utils/validate';
import { buyMinutesSchema, offersSchema } from './callMinutes.schemas';
import * as svc from './callMinutes.service';

export const callMinutesRouter = Router();
callMinutesRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const kindOf = (v: unknown): CallType => {
  if (v === 'AUDIO' || v === 'VIDEO') return v;
  throw badRequest('KIND_INVALID', 'Type d’appel invalide');
};

callMinutesRouter.get('/accounts', wrap(async (req, res) => res.json({ accounts: await svc.myAccounts(me(req)) })));
callMinutesRouter.get('/creators/:creatorId/:kind/offers', wrap(async (req, res) =>
  res.json(await svc.offersFor(String(req.params.creatorId), kindOf(req.params.kind)))));
callMinutesRouter.put('/offers', wrap(async (req, res) => res.json(await svc.setOffers(me(req), body(offersSchema, req)))));
callMinutesRouter.post('/purchases', paymentLimiter, wrap(async (req, res) =>
  res.status(202).json(await svc.buyMinutes(me(req), body(buyMinutesSchema, req)))));
callMinutesRouter.get('/purchases/:id', wrap(async (req, res) =>
  res.json(await svc.purchaseStatus(me(req), String(req.params.id)))));
