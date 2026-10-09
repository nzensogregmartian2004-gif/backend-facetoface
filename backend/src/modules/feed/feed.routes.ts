import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { badRequest, notFound } from '../../utils/errors';
import { parse } from '../../utils/validate';
import { feedQuerySchema } from '../content/content.schemas';
import { localFeedQuerySchema } from '../discovery/discovery.schemas';
import { getFeed, getLocalFeed } from './feed.service';

export const feedRouter = Router();
feedRouter.use(requireAuth);

/** GET /api/feed/local?country=GA&type=video|short — contenus de créateurs d'un pays (défaut : le pays du compte). Avant /:tab. */
feedRouter.get('/local', wrap(async (req, res) => {
  const q = parse(localFeedQuerySchema, req.query);
  const viewer = authed(req).user;
  const country = q.country ?? viewer.country;
  if (!country) throw badRequest('COUNTRY_REQUIRED', 'Indiquez un pays (country) ou renseignez le vôtre dans votre profil');
  res.json(await getLocalFeed(viewer, q.type === 'short' ? 'SHORT' : 'VIDEO', country, { cursor: q.cursor, limit: q.limit }));
}));

/** GET /api/feed/:tab?type=video|short&cursor=&limit= — tab : for-you | following | trending. */
feedRouter.get('/:tab', wrap(async (req, res) => {
  const tab = z.enum(['for-you', 'following', 'trending']).safeParse(req.params.tab);
  if (!tab.success) throw notFound('Feed inconnu');
  const q = parse(feedQuerySchema, req.query);
  res.json(await getFeed(authed(req).user, tab.data, q.type === 'short' ? 'SHORT' : 'VIDEO', { cursor: q.cursor, limit: q.limit }));
}));
