import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import * as svc from './gifts.service';
import { giftAdminSchema, giftSendSchema, tipSchema } from './gifts.schemas';
import { isAdmin } from '../admin/admin.service';

export const giftsRouter=Router();
giftsRouter.use(requireAuth);
giftsRouter.get('/catalog',wrap(async(_req,res)=>res.json(await svc.catalog())));
giftsRouter.post('/purchases',wrap(async(req,res)=>res.status(202).json(await svc.sendGift(authed(req).user,body(giftSendSchema,req)))));
export const tipsRouter=Router();
tipsRouter.use(requireAuth);
tipsRouter.post('/',wrap(async(req,res)=>res.status(202).json(await svc.sendTip(authed(req).user,body(tipSchema,req)))));

giftsRouter.get('/admin/catalog',wrap(async(req,res)=>{
  if(!isAdmin(authed(req).user.id)) return res.status(403).json({error:{code:'ADMIN_REQUIRED',message:'Droits administrateur requis'}});
  res.json(await svc.adminList(authed(req).user));
}));
giftsRouter.post('/admin/catalog',wrap(async(req,res)=>res.status(201).json({gift:await svc.adminCreate(authed(req).user,body(giftAdminSchema,req))})));
giftsRouter.patch('/admin/catalog/:id',wrap(async(req,res)=>res.json({gift:await svc.adminUpdate(authed(req).user,String(req.params.id),body(giftAdminSchema.partial(),req))})));
