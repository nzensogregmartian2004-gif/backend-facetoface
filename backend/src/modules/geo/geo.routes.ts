import { Router } from 'express';
import { wrap } from '../../utils/async';
import { listCountries } from './geo.service';

export const geoRouter = Router();

/** GET /api/geo/countries : liste publique des pays (sans connexion). Afrique d'abord. */
geoRouter.get('/countries', wrap(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ items: listCountries() });
}));
