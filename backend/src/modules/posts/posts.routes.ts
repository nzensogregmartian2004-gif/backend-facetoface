import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { contentLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import { pageQuerySchema } from '../content/content.schemas';
import { createPostSchema, postImageUrlSchema, voteSchema } from './posts.schemas';
import * as svc from './posts.service';

export const postsRouter = Router();
postsRouter.use(requireAuth);

/** GET /api/posts — fil des posts publics, du plus récent au plus ancien. */
postsRouter.get('/', wrap(async (req, res) => {
  res.json(await svc.list(authed(req).user, parse(pageQuerySchema, req.query)));
}));

/** POST /api/posts/upload-url — demande d'envoi d'une image de post (le fichier part ensuite vers le stockage). */
postsRouter.post('/upload-url', uploadLimiter, wrap(async (req, res) => {
  res.json(await svc.imageUploadUrl(authed(req).user, body(postImageUrlSchema, req)));
}));

/** POST /api/posts — publier un post (texte, sondage et image facultatifs). */
postsRouter.post('/', contentLimiter, wrap(async (req, res) => {
  res.status(201).json({ post: await svc.create(authed(req).user, body(createPostSchema, req)) });
}));

/** POST /api/posts/:id/vote — voter pour une option du sondage (une fois). */
postsRouter.post('/:id/vote', wrap(async (req, res) => {
  res.json({ post: await svc.vote(authed(req).user, String(req.params.id), body(voteSchema, req).option) });
}));

/** DELETE /api/posts/:id — retirer son post (suppression douce). */
postsRouter.delete('/:id', wrap(async (req, res) => {
  await svc.remove(authed(req).user, String(req.params.id));
  res.status(204).end();
}));
