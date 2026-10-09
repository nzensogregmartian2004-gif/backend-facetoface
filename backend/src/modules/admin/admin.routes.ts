import { gateAdminRoute, requirePermission } from './roles';
import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import * as svc from './admin.service';
import * as fraud from '../fraud/fraud.service';
import { contentActionSchema, listQuerySchema, refundRequestSchema, reportStatusSchema, reportListQuerySchema, transactionQuerySchema, userStatusSchema, withdrawalStatusSchema, withdrawalListQuerySchema, fraudEventListQuerySchema, fraudStatusSchema } from './admin.schemas';

export const adminRouter=Router(); adminRouter.use(requireAuth, gateAdminRoute);
const me=(req:Parameters<typeof authed>[0])=>authed(req).user;
const guard=(req:Parameters<typeof authed>[0])=>{requirePermission(me(req),'admin.access');};

adminRouter.get('/dashboard',wrap(async(req,res)=>{guard(req);res.json(await svc.dashboard(me(req)))}));
adminRouter.get('/users',wrap(async(req,res)=>res.json(await svc.searchUsers(me(req),parse(listQuerySchema,req.query)))));
adminRouter.get('/users/:id',wrap(async(req,res)=>res.json({user:await svc.getUser(me(req),String(req.params.id))})));
adminRouter.patch('/users/:id/status',wrap(async(req,res)=>res.json({user:await svc.setUserStatus(me(req),String(req.params.id),parse(userStatusSchema,req.body))})));
adminRouter.patch('/videos/:id/status',wrap(async(req,res)=>res.json({video:await svc.setContentStatus(me(req),'VIDEO',String(req.params.id),parse(contentActionSchema,req.body))})));
adminRouter.patch('/shorts/:id/status',wrap(async(req,res)=>res.json({short:await svc.setContentStatus(me(req),'SHORT',String(req.params.id),parse(contentActionSchema,req.body))})));
adminRouter.get('/reports',wrap(async(req,res)=>res.json({reports:await svc.listReports(me(req),parse(reportListQuerySchema,req.query).status)})));
adminRouter.patch('/reports/:id',wrap(async(req,res)=>res.json({report:await svc.setReportStatus(me(req),String(req.params.id),parse(reportStatusSchema,req.body))})));
adminRouter.patch('/fraud/users/:id',wrap(async(req,res)=>{guard(req);res.json({user:await svc.setFraudStatus(me(req),String(req.params.id),parse(fraudStatusSchema,req.body).status,parse(fraudStatusSchema,req.body).reason)})}));
adminRouter.get('/fraud/events',wrap(async(req,res)=>{guard(req);res.json({events:await fraud.listEvents(parse(fraudEventListQuerySchema,req.query))})}));
adminRouter.get('/transactions',wrap(async(req,res)=>res.json({transactions:await svc.listTransactions(me(req),parse(transactionQuerySchema,req.query))})));
adminRouter.post('/transactions/:id/refund-review',wrap(async(req,res)=>res.json({transaction:await svc.requestRefundReview(me(req),String(req.params.id),parse(refundRequestSchema,req.body).reason)})));
adminRouter.get('/withdrawals',wrap(async(req,res)=>res.json({withdrawals:await svc.listWithdrawals(me(req),parse(withdrawalListQuerySchema,req.query).status)})));
adminRouter.patch('/withdrawals/:id',wrap(async(req,res)=>res.json(await svc.setWithdrawalStatus(me(req),String(req.params.id),parse(withdrawalStatusSchema,req.body)))));
