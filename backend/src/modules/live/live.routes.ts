import { Router } from 'express';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { chatSchema, createLiveSchema, liveListSchema, reactionSchema, updateLiveSchema } from './live.schemas';
import * as svc from './live.service';
import { closeLiveRoom } from './live.livekit';
import { liveCapabilities } from './live.capabilities';
import { env } from '../../config/env';

export const liveRouter = Router();
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

liveRouter.get('/', wrap(async (req, res) => {
  const q = parse(liveListSchema, req.query);
  res.json({ lives: await svc.listLives(q.status, q.limit) });
}));
liveRouter.use(requireAuth);
liveRouter.get('/mine', wrap(async (req, res) => { res.json(await svc.myLives(me(req))); }));
/** Capacités du direct (vidéo activée ou non) : déclaré avant /:id pour ne pas être lu comme un identifiant. */
liveRouter.get('/capabilities', wrap(async (_req, res) => res.json(liveCapabilities({ url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET }))));
liveRouter.get('/:id', wrap(async (req, res) => { res.json({ live: await svc.getLive(id(req), me(req)) }); }));
liveRouter.post('/', wrap(async (req, res) => { res.status(201).json(await svc.createLive(me(req), createLiveSchema.parse(req.body))); }));
liveRouter.patch('/:id', wrap(async (req, res) => { res.json({ live: await svc.updateLive(me(req), id(req), updateLiveSchema.parse(req.body)) }); }));
liveRouter.post('/:id/start', wrap(async (req, res) => { res.json(await svc.startLive(me(req), id(req))); }));
liveRouter.post('/:id/end', wrap(async (req, res) => { const live = await svc.endLive(me(req), id(req)); void closeLiveRoom(id(req)); res.json({ live }); }));
liveRouter.post('/:id/cancel', wrap(async (req, res) => { res.json({ live: await svc.cancelLive(me(req), id(req)) }); }));
liveRouter.post('/:id/join', wrap(async (req, res) => { res.json(await svc.joinLive(me(req), id(req))); }));
liveRouter.post('/:id/leave', wrap(async (req, res) => { res.json(await svc.leaveLive(me(req), id(req))); }));
liveRouter.get('/:id/chat', wrap(async (req, res) => { res.json({ messages: await svc.listChat(me(req), id(req)) }); }));
liveRouter.post('/:id/chat', wrap(async (req, res) => { res.status(201).json({ message: await svc.chat(me(req), id(req), chatSchema.parse(req.body).text) }); }));
liveRouter.post('/:id/reactions', wrap(async (req, res) => { res.json({ reaction: await svc.react(me(req), id(req), reactionSchema.parse(req.body).type) }); }));
liveRouter.get('/:id/stats', wrap(async (req, res) => { res.json(await svc.stats(me(req), id(req))); }));

export { liveRouter as livesRouter };
