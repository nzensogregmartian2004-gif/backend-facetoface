import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import { commentAudioUrlSchema, pageQuerySchema } from '../content/content.schemas';
import * as svc from './comments.service';

/** Commentaires par identifiant : vocal, réponses et suppression. La liste et la création sont sous /api/videos|shorts/:id/comments. */
export const commentsRouter = Router();
commentsRouter.use(requireAuth);
/** POST /api/comments/upload-url — demande d'envoi d'un vocal de commentaire (le fichier part ensuite directement vers le stockage). */
commentsRouter.post('/upload-url', uploadLimiter, wrap(async (req, res) => { res.json(await svc.audioUploadUrl(authed(req).user, body(commentAudioUrlSchema, req))); }));
/** GET /api/comments/:id/replies — réponses d'un commentaire de premier niveau, de la plus ancienne à la plus récente. */
commentsRouter.get('/:id/replies', wrap(async (req, res) => { res.json(await svc.listReplies(authed(req).user, String(req.params.id), parse(pageQuerySchema, req.query))); }));
commentsRouter.delete('/:id', wrap(async (req, res) => { await svc.remove(authed(req).user, String(req.params.id)); res.status(204).end(); }));
