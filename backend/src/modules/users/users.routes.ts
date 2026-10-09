import * as discovery from '../discovery/discovery.service';
import { popularQuerySchema } from '../discovery/discovery.schemas';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env';
import { authed, requireAuth } from '../../middleware/auth';
import { authLimiter, uploadLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { badRequest } from '../../utils/errors';
import { body, parse } from '../../utils/validate';
import { countrySchema, displayNameSchema, linksSchema, usernameSchema } from '../../utils/schemas';
import { serializeSelf } from '../../utils/serializers';
import { pageQuerySchema } from '../content/content.schemas';
import * as follows from './follow.service';
import * as profiles from './profile.service';
import { suggestCreators } from './suggestions.service';
import * as svc from './users.service';
import { isCurrencyCode } from '../monetization/currency';
import { BANNER_MAX_BYTES, featuredSchema } from './channel.schemas';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.AVATAR_MAX_BYTES, files: 1 } });
const bannerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: BANNER_MAX_BYTES, files: 1 } });

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const profileSchema = z.object({
  displayName: displayNameSchema.optional(),
  username: usernameSchema.optional(),
  bio: z.preprocess(emptyToNull, z.string().trim().max(300, '300 caractères maximum').nullable()).optional(),
  country: z.preprocess(emptyToNull, countrySchema.nullable()).optional(),
  links: linksSchema.optional(),
}).strict();

const preferencesSchema = z.object({
  preferredLanguage: z.enum(['FR', 'EN']).optional(),
  preferredCurrency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Code devise ISO 4217 invalide').optional(),
}).strict();

const privacySchema = z.object({
  profileVisibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  allowMessagesFrom: z.enum(['EVERYONE', 'FOLLOWERS', 'NOBODY']).optional(),
  showOnlineStatus: z.boolean().optional(),
  showReadReceipts: z.boolean().optional(),
}).strict();

usersRouter.get('/me', wrap(async (req, res) => { res.json({ user: serializeSelf(authed(req).user) }); }));

usersRouter.patch('/me', wrap(async (req, res) => {
  const patch = body(profileSchema, req);
  if (Object.keys(patch).length === 0) throw badRequest('EMPTY_UPDATE', 'Aucune modification fournie');
  res.json({ user: await svc.updateProfile(authed(req).user, patch) });
}));

usersRouter.put('/me/avatar', uploadLimiter, upload.single('avatar'), wrap(async (req, res) => {
  if (!req.file) throw badRequest('FILE_REQUIRED', 'Aucune image reçue (champ "avatar")');
  res.json({ user: await svc.setAvatar(authed(req).user, req.file.buffer) });
}));

usersRouter.delete('/me/avatar', wrap(async (req, res) => { res.json({ user: await svc.removeAvatar(authed(req).user) }); }));

usersRouter.put('/me/banner', uploadLimiter, bannerUpload.single('banner'), wrap(async (req, res) => {
  if (!req.file) throw badRequest('FILE_REQUIRED', 'Aucune image reçue (champ "banner")');
  res.json({ user: await svc.setBanner(authed(req).user, req.file.buffer) });
}));

usersRouter.delete('/me/banner', wrap(async (req, res) => { res.json({ user: await svc.removeBanner(authed(req).user) }); }));

usersRouter.put('/me/featured', wrap(async (req, res) => {
  res.json({ user: await svc.setFeatured(authed(req).user, body(featuredSchema, req)) });
}));

usersRouter.patch('/me/preferences', wrap(async (req, res) => {
  const patch = body(preferencesSchema, req);
  if (Object.keys(patch).length === 0) throw badRequest('EMPTY_UPDATE', 'Aucune modification fournie');
  res.json({ user: await svc.updatePreferences(authed(req).user, patch) });
}));

usersRouter.patch('/me/privacy', wrap(async (req, res) => {
  const patch = body(privacySchema, req);
  if (Object.keys(patch).length === 0) throw badRequest('EMPTY_UPDATE', 'Aucune modification fournie');
  res.json({ user: await svc.updatePrivacy(authed(req).user, patch) });
}));

usersRouter.post('/me/creator/activate', wrap(async (req, res) => { res.json({ user: await svc.setCreator(authed(req).user, true) }); }));
usersRouter.post('/me/creator/deactivate', wrap(async (req, res) => { res.json({ user: await svc.setCreator(authed(req).user, false) }); }));

usersRouter.get('/me/blocks', wrap(async (req, res) => { res.json({ users: await svc.listBlocked(authed(req).user) }); }));

usersRouter.delete('/me', authLimiter, wrap(async (req, res) => {
  await svc.deleteAccount(authed(req).user, body(z.object({ password: z.string().min(1).max(200) }), req).password);
  res.status(204).end();
}));

usersRouter.get('/check-username', wrap(async (req, res) => {
  const username = parse(usernameSchema, req.query.username);
  res.json({ username, available: await svc.usernameAvailable(username, authed(req).user.id) });
}));

usersRouter.post('/:id/block', wrap(async (req, res) => { await svc.blockUser(authed(req).user, String(req.params.id)); res.status(204).end(); }));
usersRouter.delete('/:id/block', wrap(async (req, res) => { await svc.unblockUser(authed(req).user, String(req.params.id)); res.status(204).end(); }));

usersRouter.post('/:id/follow', wrap(async (req, res) => { await follows.follow(authed(req).user, String(req.params.id)); res.status(204).end(); }));
usersRouter.delete('/:id/follow', wrap(async (req, res) => { await follows.unfollow(authed(req).user, String(req.params.id)); res.status(204).end(); }));

const profileContentQuery = pageQuerySchema.extend({ sort: z.enum(['recent', 'popular']).default('recent') });

/** Créateurs à suivre (avant `/:username`). */
usersRouter.get('/suggestions', wrap(async (req, res) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) }), req.query);
  res.json(await suggestCreators(authed(req).user, q.limit));
}));

const uname = (req: { params: Record<string, unknown> }) => String(req.params.username).toLowerCase();
/** GET /api/users/popular?country=GA&limit= — créateurs les plus suivis (profils publics), éventuellement d'un pays. */
usersRouter.get('/popular', wrap(async (req, res) => {
  res.json({ items: await discovery.popularCreators(authed(req).user, parse(popularQuerySchema, req.query)) });
}));

usersRouter.get('/:username/followers', wrap(async (req, res) => { res.json(await profiles.listRelations(authed(req).user, uname(req), 'followers', parse(pageQuerySchema, req.query))); }));
usersRouter.get('/:username/following', wrap(async (req, res) => { res.json(await profiles.listRelations(authed(req).user, uname(req), 'following', parse(pageQuerySchema, req.query))); }));
usersRouter.get('/:username/videos', wrap(async (req, res) => { res.json(await profiles.listProfileContent(authed(req).user, uname(req), 'VIDEO', parse(profileContentQuery, req.query))); }));
usersRouter.get('/:username/shorts', wrap(async (req, res) => { res.json(await profiles.listProfileContent(authed(req).user, uname(req), 'SHORT', parse(profileContentQuery, req.query))); }));

usersRouter.get('/:username/lives', wrap(async (req, res) => { res.json(await profiles.listProfileLives(authed(req).user, uname(req), parse(pageQuerySchema, req.query))); }));
usersRouter.get('/:username/paid', wrap(async (req, res) => { res.json(await profiles.listProfilePaid(authed(req).user, uname(req), parse(pageQuerySchema, req.query))); }));

usersRouter.get('/:username', wrap(async (req, res) => { res.json({ user: await profiles.getProfile(authed(req).user, uname(req)) }); }));
