import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { paymentLimiter } from '../../middleware/rateLimit';
import { body } from '../../utils/validate';
import { completeUploadSchema, disputeSchema, offerSchema, paySchema, requestSchema, uploadSchema } from './customVideos.schemas';
import * as svc from './customVideos.service';

export const customVideosRouter = Router();
customVideosRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

customVideosRouter.get('/mine', wrap(async (req,res) => res.json(await svc.listMine(me(req)))));
customVideosRouter.get('/creator/requests', wrap(async (req,res) => res.json(await svc.listCreator(me(req)))));
customVideosRouter.post('/creators/:id/requests', wrap(async (req,res) => res.status(201).json(await svc.createRequest(me(req), String(req.params.id), body(requestSchema, req)))));
customVideosRouter.get('/:id', wrap(async (req,res) => res.json(await svc.getOne(me(req), id(req)))));
customVideosRouter.post('/:id/offer', wrap(async (req,res) => res.json(await svc.offer(me(req), id(req), body(offerSchema, req)))));
customVideosRouter.post('/:id/pay', paymentLimiter, wrap(async (req,res) => { const r=await svc.pay(me(req), id(req), body(paySchema, req)); res.status(r.httpStatus).json({ request:r.request, payment:r.payment }); }));
customVideosRouter.post('/:id/accept', wrap(async (req,res) => res.json(await svc.accept(me(req), id(req)))));
customVideosRouter.post('/:id/decline', wrap(async (req,res) => res.json(await svc.decline(me(req), id(req)))));
customVideosRouter.post('/:id/cancel', wrap(async (req,res) => res.json(await svc.cancel(me(req), id(req)))));
customVideosRouter.post('/:id/upload-url', wrap(async (req,res) => res.json(await svc.uploadUrl(me(req), id(req), body(uploadSchema, req)))));
customVideosRouter.post('/:id/complete-upload', wrap(async (req,res) => res.json(await svc.completeUpload(me(req), id(req), body(completeUploadSchema, req)))));
customVideosRouter.get('/:id/playback', wrap(async (req,res) => res.json(await svc.playback(me(req), id(req)))));
customVideosRouter.post('/:id/complete', wrap(async (req,res) => res.json(await svc.complete(me(req), id(req)))));
customVideosRouter.post('/:id/dispute', wrap(async (req,res) => res.json(await svc.dispute(me(req), id(req), body(disputeSchema, req).reason))));
