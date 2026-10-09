import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { unlockLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import * as svc from './attachments.service';
import { z } from 'zod';
import { currencySchema } from '../../utils/currency';
import { uploadAttachmentSchema as uploadSchema, unlockAttachmentSchema as unlockSchema } from './attachments.schemas';


export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
attachmentsRouter.post('/upload-url', uploadLimiter, wrap(async (req,res) => res.json(await svc.requestUpload(me(req), body(uploadSchema, req)))));
attachmentsRouter.post('/:id/unlock', unlockLimiter, wrap(async (req,res) => { const { httpStatus, ...payload } = await svc.unlock(me(req), id(req), body(unlockSchema, req)); res.status(httpStatus).json(payload); }));
attachmentsRouter.get('/purchases/:id', wrap(async (req,res) => res.json(await svc.getPurchase(me(req), id(req)))));
