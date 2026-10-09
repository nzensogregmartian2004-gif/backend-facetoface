import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { messageLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import { z } from 'zod';
import * as svc from './groups.service';
import * as access from './groupAccess.service';
import { groupUpdateSchema } from './groups.schemas';

const createSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional(), allowPaidContent: z.boolean().optional(), memberIds: z.array(z.string().min(1).max(64)).max(99).optional() }).strict();
const membersSchema = z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(99) }).strict();
const roleSchema = z.object({ role: z.enum(['ADMIN','MEMBER']) }).strict();
const inviteSchema = z.object({}).strict();
const joinSchema = z.object({ token: z.string().trim().min(16).max(96) }).strict();
const revokeSchema = z.object({ token: z.string().min(16).max(96) }).strict();
/** Paiement d'entrée : jeton d'invitation, opérateur Mobile Money et numéro à débiter (jamais conservé en entier). */
const payJoinSchema = z.object({
  token: z.string().trim().min(16).max(96),
  operator: z.enum(['AIRTEL_MONEY', 'MOOV_MONEY'], { message: 'Choisissez un opérateur' }),
  phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Numéro invalide').transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 8 && v.length <= 15, 'Numéro invalide'),
}).strict();

export const groupsRouter = Router();
groupsRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

groupsRouter.post('/', messageLimiter, wrap(async (req,res) => res.status(201).json({ group: await svc.createGroup(me(req), body(createSchema, req)) })));
/** Aperçu d'une invitation : nom, membres, prix. N'engage rien. */
groupsRouter.get('/invites/:token', wrap(async (req,res) => res.json(await svc.previewInvite(String(req.params.token)))));
groupsRouter.get('/:id', wrap(async (req,res) => res.json(await svc.getGroup(me(req), id(req)))));
groupsRouter.post('/:id/photo-upload-url', messageLimiter, wrap(async (req,res) => { const b = body(z.object({ contentType: z.string().trim().toLowerCase() }).strict(), req); res.json(await svc.photoUploadUrl(me(req), id(req), b.contentType)); }));
groupsRouter.patch('/:id', messageLimiter, wrap(async (req,res) => res.json(await svc.updateGroup(me(req), id(req), body(groupUpdateSchema, req)))));
groupsRouter.post('/:id/members', messageLimiter, wrap(async (req,res) => res.json(await svc.addMembers(me(req), id(req), body(membersSchema, req).userIds))));
groupsRouter.delete('/:id/members/:userId', wrap(async (req,res) => { await svc.removeMember(me(req), id(req), String(req.params.userId)); res.status(204).end(); }));
groupsRouter.patch('/:id/members/:userId/role', wrap(async (req,res) => { await svc.setRole(me(req), id(req), String(req.params.userId), body(roleSchema, req).role); res.status(204).end(); }));
groupsRouter.post('/:id/leave', wrap(async (req,res) => { await svc.leaveGroup(me(req), id(req)); res.status(204).end(); }));
groupsRouter.post('/:id/invites', wrap(async (req,res) => { body(inviteSchema, req); res.status(201).json(await svc.createInvite(me(req), id(req))); }));
groupsRouter.delete('/:id/invites', wrap(async (req,res) => { const b=body(revokeSchema, req); await svc.revokeInvite(me(req), id(req), b.token); res.status(204).end(); }));
/** Revenus du groupe : propriétaire seulement. */
groupsRouter.get('/:id/access', wrap(async (req,res) => res.json(await access.groupAccessSummary(me(req), id(req)))));
groupsRouter.post('/join', wrap(async (req,res) => res.json(await svc.joinByInvite(me(req), body(joinSchema, req).token))));
/** POST /api/groups/join/pay — entrée payante : 202 en attente du règlement, 200 si déjà membre ou déjà payé. */
groupsRouter.post('/join/pay', messageLimiter, wrap(async (req,res) => { const { httpStatus, ...payload } = await access.payGroupAccess(me(req), body(payJoinSchema, req).token, body(payJoinSchema, req)); res.status(httpStatus).json(payload); }));
/** GET /api/groups/purchases/:id — état d'un achat d'accès (sondé après un 202). */
groupsRouter.get('/purchases/:id', wrap(async (req,res) => res.json(await access.getGroupAccessPurchase(me(req), id(req)))));
