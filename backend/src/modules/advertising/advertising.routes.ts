import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { env } from '../../config/env';
import * as svc from './advertising.service';
import { adQuerySchema, campaignStatusSchema, createCampaignSchema, impressionSchema, settingsSchema } from './advertising.schemas';

export const advertisingRouter = Router();
advertisingRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const isAdmin = (id: string) => env.VIEW_MONETIZATION_ADMIN_USER_IDS.split(',').map(x => x.trim()).filter(Boolean).includes(id);

advertisingRouter.get('/settings', wrap(async (_req, res) => res.json({ settings: await svc.getSettings() })));
advertisingRouter.get('/next', wrap(async (req, res) => {
  const q = parse(adQuerySchema, req.query);
  res.json({ ad: await svc.selectAd(me(req), q) });
}));
advertisingRouter.post('/impressions', wrap(async (req, res) => {
  const b = parse(impressionSchema, req.body);
  res.status(201).json(await svc.recordImpression(me(req), b.campaignId, b, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined }));
}));
advertisingRouter.post('/impressions/:id/click', wrap(async (req, res) => res.json({ click: await svc.recordClick(me(req), String(req.params.id), { ip: req.ip, userAgent: req.get('user-agent') ?? undefined }) })));

advertisingRouter.use('/admin', (req, res, next) => isAdmin(me(req).id) ? next() : res.status(403).json({ error: { code: 'ADMIN_REQUIRED', message: 'Droits administrateur requis' } }));
advertisingRouter.get('/admin/settings', wrap(async (_req, res) => res.json({ settings: await svc.getSettings() })));
advertisingRouter.patch('/admin/settings', wrap(async (req, res) => res.json({ settings: await svc.updateSettings(parse(settingsSchema, req.body), me(req).id) })));
advertisingRouter.get('/admin/campaigns', wrap(async (req, res) => res.json({ campaigns: await svc.listCampaigns(typeof req.query.status === 'string' ? req.query.status : undefined) })));
advertisingRouter.post('/admin/campaigns', wrap(async (req, res) => res.status(201).json({ campaign: await svc.createCampaign(me(req).id, parse(createCampaignSchema, req.body)) })));
advertisingRouter.patch('/admin/campaigns/:id/status', wrap(async (req, res) => res.json({ campaign: await svc.setCampaignStatus(String(req.params.id), parse(campaignStatusSchema, req.body).status) })));
advertisingRouter.get('/admin/report', wrap(async (req, res) => res.json(await svc.report(typeof req.query.currency === 'string' ? req.query.currency : undefined))));
