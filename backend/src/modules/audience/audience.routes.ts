import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import * as svc from './audience.service';

/** Audience géographique : réservée au créateur connecté, données agrégées uniquement. */
export const audienceRouter = Router();
audienceRouter.use(requireAuth);
const query = z.object({ range: z.enum(['7d', '30d', '90d', '12m']).default('30d') }).strict();
audienceRouter.get('/countries', wrap(async (req, res) => {
  const q = parse(query, req.query);
  res.json(await svc.audienceCountries(authed(req).user, q.range));
}));
