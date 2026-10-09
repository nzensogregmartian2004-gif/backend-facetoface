import { Router } from 'express';
import { requireAuth, authed } from '../../middleware/auth';
import { searchLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { CATEGORIES } from '../content/categories';
import { searchQuerySchema } from './search.schemas';
import { hashtagContentsQuerySchema, hashtagQuerySchema } from '../discovery/discovery.schemas';
import * as discovery from '../discovery/discovery.service';
import { normalizeTag } from '../discovery/tags';
import { search } from './search.service';

export const searchRouter = Router();
searchRouter.use(requireAuth);

/** GET /api/search?q=&type=creators|users|videos|shorts&sort=popular|recent|views&category=&cursor=&limit= */
searchRouter.get('/', searchLimiter, wrap(async (req, res) => {
  res.json(await search(authed(req).user, parse(searchQuerySchema, req.query)));
}));

/** GET /api/search/hashtags?q=gab — hashtags qui commencent par q ; sans q : tendances de la semaine. */
searchRouter.get('/hashtags', searchLimiter, wrap(async (req, res) => {
  const q = parse(hashtagQuerySchema, req.query);
  res.json(await discovery.searchHashtags(q.q, q.limit));
}));

/** GET /api/search/hashtags/:tag/contents?type=video|short&cursor= — contenus publiés portant ce hashtag. */
searchRouter.get('/hashtags/:tag/contents', searchLimiter, wrap(async (req, res) => {
  const q = parse(hashtagContentsQuerySchema, req.query);
  const tag = normalizeTag(String(req.params.tag).replace(/^#+/, ''));
  res.json(await discovery.hashtagContents(authed(req).user, tag, q.type === 'short' ? 'SHORT' : 'VIDEO', { cursor: q.cursor, limit: q.limit }));
}));

/** Catégories filtrables (mêmes que celles de la publication). */
searchRouter.get('/categories', wrap(async (_req, res) => { res.json({ categories: CATEGORIES }); }));
