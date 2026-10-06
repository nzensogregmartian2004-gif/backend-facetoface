import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { commentLimiter, contentLimiter, shareLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { badRequest } from '../../utils/errors';
import { body, parse } from '../../utils/validate';
import * as comments from '../comments/comments.service';
import { CATEGORIES } from './categories';
import * as svc from './content.service';
import { commentSchema, completeUploadSchema, createContentSchema, mineQuerySchema, pageQuerySchema, updateContentSchema, uploadUrlSchema, viewSchema } from './content.schemas';
import * as inter from './interactions.service';
import type { Kind } from './types';

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

  r.post('/:id/upload-url', contentLimiter, wrap(async (req, res) => { res.json(await svc.requestUpload(authed(req).user, kind, id(req), body(uploadUrlSchema, req))); }));
  r.post('/:id/complete-upload', wrap(async (req, res) => { res.json({ [key]: await svc.completeUpload(authed(req).user, kind, id(req), body(completeUploadSchema, req)) }); }));
  r.post('/:id/publish', wrap(async (req, res) => { res.json({ [key]: await svc.publish(authed(req).user, kind, id(req)) }); }));

  r.get('/:id/playback', wrap(async (req, res) => { res.json(await svc.playback(authed(req).user, kind, id(req))); }));
  r.get('/:id/download-url', wrap(async (req, res) => { res.json(await svc.downloadUrl(authed(req).user, kind, id(req))); }));

  r.post('/:id/like', wrap(async (req, res) => { res.json(await inter.like(authed(req).user, kind, id(req))); }));
  r.delete('/:id/like', wrap(async (req, res) => { res.json(await inter.unlike(authed(req).user, kind, id(req))); }));
  r.post('/:id/view', wrap(async (req, res) => { const b = body(viewSchema, req); res.json(await inter.recordView(authed(req).user, kind, id(req), b.watchedSeconds, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined })); }));
  r.post('/:id/share', shareLimiter, wrap(async (req, res) => { res.json(await inter.share(authed(req).user, kind, id(req))); }));

  r.get('/:id/comments', wrap(async (req, res) => { res.json(await comments.list(authed(req).user, kind, id(req), parse(pageQuerySchema, req.query))); }));
  r.post('/:id/comments', commentLimiter, wrap(async (req, res) => { res.status(201).json({ comment: await comments.create(authed(req).user, kind, id(req), body(commentSchema, req).text) }); }));

  return r;
}
