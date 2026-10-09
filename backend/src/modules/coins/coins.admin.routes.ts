import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import { coinAdjustSchema } from './coins.schemas';
import * as svc from './coins.admin.service';

/** Administration des coins : solde d'un utilisateur, ajustement contrôlé, journal. Réservé aux administrateurs (contrôlé par le service). */
export const adminCoinsRouter = Router();
adminCoinsRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

adminCoinsRouter.get('/audit', wrap(async (req, res) => { res.json(await svc.coinsAudit(me(req), Number(req.query.limit ?? 50))); }));
adminCoinsRouter.get('/users/:id', wrap(async (req, res) => { res.json(await svc.userCoins(me(req), id(req))); }));
adminCoinsRouter.post('/users/:id/adjust', wrap(async (req, res) => { res.status(201).json(await svc.adjustBalance(me(req), id(req), body(coinAdjustSchema, req))); }));
