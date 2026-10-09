import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { currencyQuerySchema } from './monetization.schemas';
import * as svc from './monetization.service';
import * as views from './views.service';
import { requirePermission } from '../admin/roles';
import { adRevenueSchema, poolPeriodSchema, poolSettingSchema, monetizationConditionUpdateSchema } from './monetization.schemas';
import * as eligibility from './eligibility.service';

export const monetizationRouter = Router();
monetizationRouter.get('/settings', wrap(async (_req, res) => { res.json(svc.publicMonetizationSettings()); }));
monetizationRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
monetizationRouter.get('/creator/earnings', wrap(async (req, res) => { res.json(await svc.getCreatorEarnings(me(req), parse(currencyQuerySchema, req.query).currency)); }));
monetizationRouter.get('/creator/breakdown', wrap(async (req, res) => { res.json(await svc.getCreatorBreakdown(me(req), parse(currencyQuerySchema, req.query).currency)); }));


monetizationRouter.get('/creator/view-earnings', wrap(async (req, res) => {
  res.json(await views.getCreatorViewEarnings(me(req), parse(currencyQuerySchema, req.query).currency));
}));

monetizationRouter.get('/creator/eligibility', wrap(async (req, res) => {
  res.json(await eligibility.evaluateCreatorEligibility(me(req).id));
}));
monetizationRouter.get('/conditions', wrap(async (_req, res) => {
  res.json({ conditions: await eligibility.getMonetizationConditions() });
}));

monetizationRouter.post('/admin/view-revenue', wrap(async (req, res) => {
  requirePermission(me(req), 'finance.revenue.view');
  res.status(201).json({ revenue: await views.recordAdvertisingRevenue(adRevenueSchema.parse(req.body)) });
}));

monetizationRouter.post('/admin/view-pool/allocate', wrap(async (req, res) => {
  requirePermission(me(req), 'finance.creator_rules.update');
  const p = poolPeriodSchema.parse(req.body);
  res.json({ pool: await views.allocateCreatorPool(p.start, p.end, p.currency) });
}));

monetizationRouter.patch('/admin/view-pool/settings', wrap(async (req, res) => {
  requirePermission(me(req), 'finance.creator_rules.update');
  const p = poolSettingSchema.parse(req.body);
  res.json({ setting: await views.setViewMonetizationSetting(p.key, p.value, me(req).id, p.reason) });
}));
monetizationRouter.patch('/admin/conditions', wrap(async (req, res) => {
  requirePermission(me(req), 'finance.creator_rules.update');
  const p = monetizationConditionUpdateSchema.parse(req.body);
  res.json({ setting: await eligibility.setMonetizationCondition(p.key, p.value, me(req).id, p.reason) });
}));
monetizationRouter.post('/admin/creator/:creatorId/eligibility-review', wrap(async (req, res) => {
  requirePermission(me(req), 'creators.eligibility.review');
  const status = z.object({ status: z.enum(['APPROVED', 'REJECTED']), rejectionReason: z.string().trim().max(500).optional() }).parse(req.body);
  res.json({ eligibility: await eligibility.reviewCreatorEligibility(req.params.creatorId, status.status, me(req).id, status.rejectionReason) });
}));

