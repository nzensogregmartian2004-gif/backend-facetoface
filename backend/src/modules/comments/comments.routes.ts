import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import * as svc from './comments.service';

/** Suppression d'un commentaire par identifiant (la liste et la création sont sous /api/videos|shorts/:id/comments). */
export const commentsRouter = Router();
commentsRouter.use(requireAuth);
commentsRouter.delete('/:id', wrap(async (req, res) => { await svc.remove(authed(req).user, String(req.params.id)); res.status(204).end(); }));
