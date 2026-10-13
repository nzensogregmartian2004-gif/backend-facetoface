import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { pageQuerySchema } from '../content/content.schemas';
import * as svc from './saved.service';

/** Bibliothèque des enregistrements. L'enregistrement lui-même reste sur /api/videos|shorts/:id/save. */
export const savedRouter = Router();
savedRouter.use(requireAuth);

/** GET /api/saved — vidéos longues et Shorts enregistrés, du plus récent au plus ancien. */
savedRouter.get('/', wrap(async (req, res) => { res.json(await svc.listSaved(authed(req).user, parse(pageQuerySchema, req.query))); }));
