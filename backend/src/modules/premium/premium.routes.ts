import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { paymentLimiter } from '../../middleware/rateLimit';
import { parse } from '../../utils/validate';
import * as svc from './premium.service';
import { subscribeSchema, settingsSchema, promotionSchema, statusSchema } from './premium.schemas';

export const premiumRouter=Router();
premiumRouter.use(requireAuth);
const me=(req:Parameters<typeof authed>[0])=>authed(req).user;

premiumRouter.get('/settings',wrap(async(_req,res)=>res.json({settings:await svc.getSettings()})));
premiumRouter.get('/me',wrap(async(req,res)=>res.json(await svc.getMySubscription(me(req)))));
premiumRouter.post('/trial',wrap(async(req,res)=>res.json(await svc.startTrial(me(req)))));
premiumRouter.post('/subscribe',paymentLimiter,wrap(async(req,res)=>{const b=parse(subscribeSchema,req.body);const r=await svc.subscribe(me(req),b);res.status(r.httpStatus).json(r);}));
premiumRouter.post('/renew',paymentLimiter,wrap(async(req,res)=>{const b=parse(subscribeSchema.omit({billingPeriod:true}),req.body);const r=await svc.renew(me(req),b);res.status(r.httpStatus).json(r);}));
premiumRouter.post('/cancel-renewal',wrap(async(req,res)=>res.json(await svc.cancelRenewal(me(req)))));

premiumRouter.get('/admin/settings',wrap(async(req,res)=>res.json({settings:await svc.getSettings()})));
premiumRouter.patch('/admin/settings',wrap(async(req,res)=>res.json({settings:await svc.updateSettings(me(req).id,parse(settingsSchema,req.body))})));
premiumRouter.get('/admin/promotions',wrap(async(req,res)=>res.json({promotions:await svc.listPromotions(me(req))})));
premiumRouter.post('/admin/promotions',wrap(async(req,res)=>res.status(201).json({promotion:await svc.createPromotion(me(req),parse(promotionSchema,req.body))})));
premiumRouter.patch('/admin/promotions/:id',wrap(async(req,res)=>res.json({promotion:await svc.setPromotionStatus(me(req),String(req.params.id),parse(statusSchema,req.body).isActive)})));
