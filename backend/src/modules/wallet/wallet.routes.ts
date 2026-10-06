import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { paymentLimiter } from '../../middleware/rateLimit';
import { body, parse } from '../../utils/validate';
import { transactionQuerySchema, withdrawalSchema } from './wallet.schemas';
import * as svc from './wallet.service';

export const walletRouter = Router();
walletRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
walletRouter.get('/', wrap(async (req,res) => { const q=parse(transactionQuerySchema, req.query); res.json(await svc.getWallet(me(req), q.currency)); }));
walletRouter.get('/transactions', wrap(async (req,res) => { const q=parse(transactionQuerySchema, req.query); res.json(await svc.getTransactions(me(req), q.currency, q.status, q.limit)); }));
walletRouter.get('/ledger', wrap(async (req,res) => { const q=parse(transactionQuerySchema, req.query); res.json(await svc.getLedger(me(req), q.currency, q.limit)); }));
walletRouter.get('/withdrawals', wrap(async (req,res) => { const q=parse(transactionQuerySchema, req.query); res.json(await svc.getWithdrawals(me(req), q.currency, q.limit)); }));
walletRouter.post('/withdrawals', paymentLimiter, wrap(async (req,res) => res.status(201).json(await svc.requestWithdrawal(me(req), body(withdrawalSchema, req)))));
