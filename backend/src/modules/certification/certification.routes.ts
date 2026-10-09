import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { body, parse } from '../../utils/validate';
import * as svc from './certification.service';

/** Certification officielle : seul un administrateur certifie ou révoque. Le badge public vient de ces décisions, jamais de l'e-mail vérifié. */
export const certificationRouter = Router();
certificationRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.userId);

const listQuery = z.object({ status: z.enum(['NON_CERTIFIED', 'PENDING', 'CERTIFIED', 'REVOKED']).optional() }).strict();
const certifyBody = z.object({ reason: z.string().trim().min(3, 'Motif trop court').max(300).optional() }).strict();
const revokeBody = z.object({ reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300) }).strict();

certificationRouter.get('/', wrap(async (req, res) => { res.json(await svc.list(me(req), parse(listQuery, req.query).status)); }));
certificationRouter.get('/:userId/history', wrap(async (req, res) => { res.json(await svc.history(me(req), id(req))); }));
certificationRouter.post('/:userId/certify', wrap(async (req, res) => { res.status(201).json(await svc.certify(me(req), id(req), body(certifyBody, req).reason ?? null)); }));
certificationRouter.post('/:userId/revoke', wrap(async (req, res) => { res.status(201).json(await svc.revoke(me(req), id(req), body(revokeBody, req).reason)); }));
