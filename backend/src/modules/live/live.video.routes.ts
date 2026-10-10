import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import * as svc from './live.video.service';

/** Vidéo et modération du Live : jeton, co-hosts, muet, blocage, suppression de message, bilan. */
export const liveVideoRouter = Router();
liveVideoRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
const userParam = (req: { params: Record<string, unknown> }) => String(req.params.userId);

const inviteBody = z.object({ userId: z.string().min(1).max(60) }).strict();
const respondBody = z.object({ accept: z.boolean() }).strict();
const muteBody = z.object({ muted: z.boolean() }).strict();

liveVideoRouter.post('/:id/token', wrap(async (req, res) => { res.json(await svc.issueLiveToken(me(req), id(req))); }));
liveVideoRouter.post('/:id/cohosts', wrap(async (req, res) => { res.status(201).json(await svc.inviteCoHost(me(req), id(req), parse(inviteBody, req.body).userId)); }));
liveVideoRouter.post('/:id/cohosts/respond', wrap(async (req, res) => { res.json(await svc.respondCoHostInvite(me(req), id(req), parse(respondBody, req.body).accept)); }));
liveVideoRouter.delete('/:id/cohosts/:userId', wrap(async (req, res) => { res.json(await svc.removeCoHost(me(req), id(req), userParam(req))); }));
liveVideoRouter.post('/:id/participants/:userId/mute', wrap(async (req, res) => { res.json(await svc.setMuted(me(req), id(req), userParam(req), parse(muteBody, req.body).muted)); }));
liveVideoRouter.post('/:id/participants/:userId/block', wrap(async (req, res) => { res.json(await svc.blockParticipant(me(req), id(req), userParam(req))); }));
liveVideoRouter.delete('/:id/chat/:messageId', wrap(async (req, res) => { res.json(await svc.deleteChatMessage(me(req), id(req), String(req.params.messageId))); }));
liveVideoRouter.get('/:id/report', wrap(async (req, res) => { res.json(await svc.liveReport(me(req), id(req))); }));
liveVideoRouter.get('/:id/cohosts', wrap(async (req, res) => { res.json(await svc.listCoHosts(me(req), id(req))); }));
liveVideoRouter.get('/:id/participation', wrap(async (req, res) => { res.json(await svc.myParticipation(me(req), id(req))); }));
liveVideoRouter.get('/:id/viewers', wrap(async (req, res) => { res.json(await svc.listViewers(me(req), id(req))); }));
liveVideoRouter.get('/:id/revenue', wrap(async (req, res) => { res.json(await svc.liveRevenue(me(req), id(req))); }));
