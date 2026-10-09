import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { messageLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import * as svc from './stories.service';

const uploadSchema = z.object({ contentType: z.string().trim().toLowerCase().max(100), sizeBytes: z.number().int().min(1, 'Fichier vide') }).strict();
const publishSchema = z.object({
  mediaKey: z.string().min(1).max(300),
  caption: z.string().trim().max(200, '200 caractères maximum').optional(),
  hours: z.number().int().optional(),
}).strict();

export const storiesRouter = Router();
storiesRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;

storiesRouter.get('/settings', wrap(async (_req, res) => res.json(await svc.settings())));
storiesRouter.post('/upload-url', uploadLimiter, wrap(async (req, res) => res.json(await svc.requestUpload(me(req), body(uploadSchema, req)))));
storiesRouter.post('/', messageLimiter, wrap(async (req, res) => res.status(201).json(await svc.publish(me(req), body(publishSchema, req)))));
storiesRouter.get('/mine', wrap(async (req, res) => res.json(await svc.mine(me(req)))));
storiesRouter.get('/users/:userId', wrap(async (req, res) => res.json(await svc.storiesOf(me(req), String(req.params.userId)))));
storiesRouter.post('/:id/view', wrap(async (req, res) => { await svc.markViewed(me(req), String(req.params.id)); res.status(204).end(); }));
storiesRouter.delete('/:id', wrap(async (req, res) => { await svc.remove(me(req), String(req.params.id)); res.status(204).end(); }));
