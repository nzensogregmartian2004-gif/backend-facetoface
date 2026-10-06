import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { isAdmin } from '../admin/admin.service';
import { forbidden } from '../../utils/errors';
import { authed } from '../../middleware/auth';
import { configVersionListSchema, listConfigSchema, restoreDefaultsSchema, updateConfigSchema, upsertConfigSchema } from './config.schemas';
import { getConfig, getConfigVersion, listConfigVersions, listConfigs, restoreDefaults, updateConfig, upsertConfig } from './config.service';

export const configRouter = Router();
configRouter.use(requireAuth);
configRouter.use((req, _res, next) => {
  if (!isAdmin(authed(req).user.id)) return next(forbidden('ADMIN_REQUIRED', 'Droits administrateur requis'));
  next();
});

configRouter.get('/versions', async (req, res, next) => {
  try {
    const parsed = configVersionListSchema.parse(req.query);
    res.json(await listConfigVersions(authed(req).user.id, parsed));
  } catch (e) { next(e); }
});

configRouter.get('/versions/:version', async (req, res, next) => {
  try {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version <= 0) throw new Error('Invalid configuration version');
    res.json(await getConfigVersion(authed(req).user.id, version));
  } catch (e) { next(e); }
});

configRouter.get('/', async (req, res, next) => {
  try {
    const parsed = listConfigSchema.parse(req.query);
    res.json(await listConfigs(authed(req).user.id, parsed));
  } catch (e) { next(e); }
});

configRouter.post('/restore-defaults', async (req, res, next) => {
  try { restoreDefaultsSchema.parse(req.body); res.json(await restoreDefaults(authed(req).user.id)); } catch (e) { next(e); }
});

configRouter.get('/:key', async (req, res, next) => {
  try { res.json(await getConfig(authed(req).user.id, req.params.key)); } catch (e) { next(e); }
});

configRouter.post('/', async (req, res, next) => {
  try {
    const input = upsertConfigSchema.parse(req.body);
    res.status(201).json(await upsertConfig(authed(req).user.id, input));
  } catch (e) { next(e); }
});

configRouter.patch('/:key', async (req, res, next) => {
  try {
    const input = updateConfigSchema.parse(req.body);
    res.json(await updateConfig(authed(req).user.id, req.params.key, input));
  } catch (e) { next(e); }
});

