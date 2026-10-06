import { Router } from 'express';
import { z } from 'zod';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { notFound } from '../../utils/errors';
import { parse } from '../../utils/validate';
import { feedQuerySchema } from '../content/content.schemas';
import { getFeed } from './feed.service';

export const feedRouter = Router();
feedRouter.use(requireAuth);

/** GET /api/feed/:tab?type=video|short&cursor=&limit= — tab : for-you | following | trending. */
feedRouter.get('/:tab', wrap(async (req, res) => {
  const tab = z.enum(['for-you', 'following', 'trending']).safeParse(req.params.tab);
  if (!tab.success) throw notFound('Feed inconnu');
  const q = parse(feedQuerySchema, req.query);
  res.json(await getFeed(authed(req).user, tab.data, q.type === 'short' ? 'SHORT' : 'VIDEO', { cursor: q.cursor, limit: q.limit }));
}));
