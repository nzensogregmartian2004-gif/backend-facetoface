import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import { commentAudioUrlSchema } from '../content/content.schemas';
import * as svc from './comments.service';

/** Suppression d'un commentaire par identifiant (la liste et la création sont sous /api/videos|shorts/:id/comments). */
export const commentsRouter = Router();
commentsRouter.use(requireAuth);
/** POST /api/comments/upload-url — demande d'envoi d'un vocal de commentaire (le fichier part ensuite directement vers le stockage). */
commentsRouter.post('/upload-url', uploadLimiter, wrap(async (req, res) => { res.json(await svc.audioUploadUrl(authed(req).user, body(commentAudioUrlSchema, req))); }));
commentsRouter.delete('/:id', wrap(async (req, res) => { await svc.remove(authed(req).user, String(req.params.id)); res.status(204).end(); }));
