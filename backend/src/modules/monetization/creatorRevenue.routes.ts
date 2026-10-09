import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import * as svc from './creatorRevenue.service';

/** Revenus détaillés du créateur (cadeaux et pourboires). Montée sur le même préfixe que le module monétisation. */
export const creatorRevenueRouter = Router();
const query = z.object({ range: z.enum(['7d', '30d', '90d', '12m']).default('30d') }).strict();
creatorRevenueRouter.get('/creator/gifts-summary', requireAuth, wrap(async (req, res) => {
  res.json(await svc.creatorGiftsSummary(authed(req).user, parse(query, req.query).range));
}));
creatorRevenueRouter.get('/creator/videos/stats', requireAuth, wrap(async (req, res) => {
  res.json(await svc.creatorVideoStats(authed(req).user, parse(query, req.query).range));
}));
