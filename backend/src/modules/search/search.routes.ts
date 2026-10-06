import { Router } from 'express';
import { requireAuth, authed } from '../../middleware/auth';
import { searchLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { CATEGORIES } from '../content/categories';
import { searchQuerySchema } from './search.schemas';
import { search } from './search.service';

export const searchRouter = Router();
searchRouter.use(requireAuth);

/** GET /api/search?q=&type=creators|users|videos|shorts&sort=popular|recent|views&category=&cursor=&limit= */
searchRouter.get('/', searchLimiter, wrap(async (req, res) => {
  res.json(await search(authed(req).user, parse(searchQuerySchema, req.query)));
}));

/** Catégories filtrables (mêmes que celles de la publication). */
searchRouter.get('/categories', wrap(async (_req, res) => { res.json({ categories: CATEGORIES }); }));
