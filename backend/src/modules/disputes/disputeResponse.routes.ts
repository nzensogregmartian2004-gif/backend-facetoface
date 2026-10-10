import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import * as svc from './disputeResponse.service';

/** Réponse du créateur à un litige. Le créateur seul peut répondre, une fois, avant l'échéance. */
export const disputeResponseRouter = Router();
disputeResponseRouter.use(requireAuth);
const responseSchema = z.object({ response: z.string().trim().min(10, 'Réponse trop courte (10 caractères minimum)').max(1000) }).strict();
disputeResponseRouter.get('/mine', wrap(async (req, res) => {
  res.json(await svc.listMyDisputes(authed(req).user.id));
}));
disputeResponseRouter.post('/calls/:id/response', wrap(async (req, res) => {
  res.json(await svc.respondToCallDispute(authed(req).user.id, String(req.params.id), body(responseSchema, req).response));
}));
disputeResponseRouter.post('/custom-videos/:id/response', wrap(async (req, res) => {
  res.json(await svc.respondToCustomVideoDispute(authed(req).user.id, String(req.params.id), body(responseSchema, req).response));
}));
