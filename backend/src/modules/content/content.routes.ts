import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { commentLimiter, contentLimiter, shareLimiter, watchLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { badRequest } from '../../utils/errors';
import { body, parse } from '../../utils/validate';
import * as comments from '../comments/comments.service';
import { CATEGORIES } from './categories';
import * as svc from './content.service';
import { commentSchema, completeUploadSchema, createContentSchema, mineQuerySchema, multipartPartSchema, multipartStartSchema, pageQuerySchema, retentionQuerySchema, updateContentSchema, uploadUrlSchema, viewSchema, watchBatchSchema } from './content.schemas';
import * as multipart from './multipart.service';
import * as shortWatch from './shortWatch.service';
import * as inter from './interactions.service';
import * as paid from './paidContent.service';
import type { Kind } from './types';
import { z } from 'zod';

const MOBILE_OPERATORS = ['AIRTEL_MONEY', 'MOOV_MONEY'] as const;
/**
 * `operator` est le nom canonique. `method` (nom envoyé aujourd'hui par l'application mobile) reste accepté
 * pendant la transition, pour ne casser aucun client existant. Le service reçoit toujours `{ operator, phone }`.
 */
const purchaseSchema = z.object({
  operator: z.enum(MOBILE_OPERATORS).optional(),
  method: z.enum(MOBILE_OPERATORS).optional(),
  phone: z.string().trim().min(6).max(30),
}).strict()
  .refine((v) => v.operator !== undefined || v.method !== undefined, { message: 'operator requis', path: ['operator'] })
  .transform((v) => ({ operator: (v.operator ?? v.method) as (typeof MOBILE_OPERATORS)[number], phone: v.phone }));

/** Un routeur par type de contenu (`/api/videos`, `/api/shorts`) : mêmes routes, même code. */
export function createContentRouter(kind: Kind) {
  const r = Router();
  r.use(requireAuth);
  const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

  r.get('/categories', (_req, res) => { res.json({ categories: CATEGORIES }); });

  r.get('/mine', wrap(async (req, res) => { res.json(await svc.listMine(authed(req).user, kind, parse(mineQuerySchema, req.query))); }));

  r.post('/', contentLimiter, wrap(async (req, res) => {
    res.status(201).json({ [kind === 'VIDEO' ? 'video' : 'short']: await svc.createDraft(authed(req).user, kind, body(createContentSchema, req)) });
  }));

  const key = kind === 'VIDEO' ? 'video' : 'short';

  r.get('/:id', wrap(async (req, res) => { res.json({ [key]: await svc.getOne(authed(req).user, kind, id(req)) }); }));

  r.patch('/:id', wrap(async (req, res) => {
    const patch = body(updateContentSchema, req);
    if (Object.keys(patch).length === 0) throw badRequest('EMPTY_UPDATE', 'Aucune modification fournie');
    res.json({ [key]: await svc.update(authed(req).user, kind, id(req), patch) });
  }));

  r.delete('/:id', wrap(async (req, res) => { await svc.remove(authed(req).user, kind, id(req)); res.status(204).end(); }));

  r.post('/:id/purchase', wrap(async (req, res) => {
    const result = await paid.purchase(authed(req).user, kind, id(req), body(purchaseSchema, req));
    const { httpStatus, ...payload } = result;
    res.status(httpStatus).json(payload);
  }));

  r.post('/:id/upload-url', contentLimiter, wrap(async (req, res) => { res.json(await svc.requestUpload(authed(req).user, kind, id(req), body(uploadUrlSchema, req))); }));
  // Envoi par parties (lot 3) : début, état (reprise), URL par partie, finalisation, annulation.
  r.post('/:id/multipart/start', contentLimiter, wrap(async (req, res) => { res.json(await multipart.startMultipart(authed(req).user, kind, id(req), body(multipartStartSchema, req))); }));
  r.get('/:id/multipart', wrap(async (req, res) => { res.json(await multipart.multipartStatus(authed(req).user, kind, id(req))); }));
  r.post('/:id/multipart/part-url', wrap(async (req, res) => { res.json(await multipart.multipartPartUrl(authed(req).user, kind, id(req), body(multipartPartSchema, req).partNumber)); }));
  r.post('/:id/multipart/complete', wrap(async (req, res) => { res.json(await multipart.multipartComplete(authed(req).user, kind, id(req))); }));
  r.delete('/:id/multipart', wrap(async (req, res) => { res.json(await multipart.multipartAbort(authed(req).user, kind, id(req))); }));
  r.post('/:id/complete-upload', wrap(async (req, res) => { res.json({ [key]: await svc.completeUpload(authed(req).user, kind, id(req), body(completeUploadSchema, req)) }); }));
  r.post('/:id/publish', wrap(async (req, res) => { res.json({ [key]: await svc.publish(authed(req).user, kind, id(req)) }); }));
  r.post('/:id/retry-processing', contentLimiter, wrap(async (req, res) => { res.json({ [key]: await svc.retryProcessing(authed(req).user, kind, id(req)) }); }));

  r.get('/:id/playback', wrap(async (req, res) => { res.json(await svc.playback(authed(req).user, kind, id(req))); }));
  r.get('/:id/similar', wrap(async (req, res) => { res.json({ items: await svc.similar(authed(req).user, kind, id(req)) }); }));
  r.get('/:id/download-url', wrap(async (req, res) => { res.json(await svc.downloadUrl(authed(req).user, kind, id(req))); }));

  r.post('/:id/like', wrap(async (req, res) => { res.json(await inter.like(authed(req).user, kind, id(req))); }));
  r.delete('/:id/like', wrap(async (req, res) => { res.json(await inter.unlike(authed(req).user, kind, id(req))); }));
  r.post('/:id/view', wrap(async (req, res) => { const b = body(viewSchema, req); res.json(await inter.recordView(authed(req).user, kind, id(req), b.watchedSeconds, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined })); }));
  r.post('/:id/share', shareLimiter, wrap(async (req, res) => { res.json(await inter.share(authed(req).user, kind, id(req))); }));

  r.get('/:id/comments', wrap(async (req, res) => { res.json(await comments.list(authed(req).user, kind, id(req), parse(pageQuerySchema, req.query))); }));
  r.post('/:id/comments', commentLimiter, wrap(async (req, res) => { res.status(201).json({ comment: await comments.create(authed(req).user, kind, id(req), body(commentSchema, req)) }); }));

  if (kind === 'SHORT') {
    // Étape 11 : temps de visionnage envoyé par lots, et rétention du créateur (agrégée, sans identité).
    r.post('/:id/watch', watchLimiter, wrap(async (req, res) => { res.json(await shortWatch.recordWatchBatch(authed(req).user, id(req), body(watchBatchSchema, req).sessions)); }));
    r.get('/stats/retention', wrap(async (req, res) => { res.json(await shortWatch.creatorShortRetention(authed(req).user, parse(retentionQuerySchema, req.query).range)); }));
  }

  return r;
}
