import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, authed } from '../../middleware/auth';
import { authLimiter, sensitiveLimiter } from '../../middleware/rateLimit';
import { wrap } from '../../utils/async';
import { notFound } from '../../utils/errors';
import { body } from '../../utils/validate';
import { birthDateSchema, codeSchema, displayNameSchema, emailSchema, passwordSchema, usernameSchema } from '../../utils/schemas';
import * as svc from './auth.service';

export const authRouter = Router();

const registerSchema = z.object({ email: emailSchema, username: usernameSchema, password: passwordSchema, displayName: displayNameSchema, birthDate: birthDateSchema });
const loginSchema = z.object({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(200) });
const tokenSchema = z.object({ refreshToken: z.string().min(10).max(500) });

authRouter.post('/register', authLimiter, wrap(async (req, res) => {
  res.status(201).json(await svc.register(body(registerSchema, req), req));
}));

authRouter.post('/login', authLimiter, wrap(async (req, res) => {
  const { identifier, password } = body(loginSchema, req);
  res.json(await svc.login(identifier, password, req));
}));

authRouter.post('/refresh', authLimiter, wrap(async (req, res) => {
  res.json(await svc.refresh(body(tokenSchema, req).refreshToken));
}));

authRouter.post('/logout', wrap(async (req, res) => {
  await svc.logout(body(tokenSchema, req).refreshToken);
  res.status(204).end();
}));

authRouter.post('/logout-all', requireAuth, wrap(async (req, res) => {
  await svc.logoutAll(authed(req).user.id);
  res.status(204).end();
}));

// Récupération de compte : réponse identique que le compte existe ou non (pas d'énumération).
authRouter.post('/forgot-password', sensitiveLimiter, wrap(async (req, res) => {
  await svc.requestPasswordReset(body(z.object({ email: emailSchema }), req).email);
  res.json({ ok: true });
}));

authRouter.post('/reset-password', authLimiter, wrap(async (req, res) => {
  const b = body(z.object({ email: emailSchema, code: codeSchema, newPassword: passwordSchema }), req);
  await svc.resetPassword(b.email, b.code, b.newPassword);
  res.json({ ok: true });
}));

authRouter.post('/change-password', requireAuth, authLimiter, wrap(async (req, res) => {
  const b = body(z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }), req);
  const { user, sessionId } = authed(req);
  await svc.changePassword(user, sessionId, b.currentPassword, b.newPassword);
  res.json({ ok: true });
}));

authRouter.post('/verify-email/request', sensitiveLimiter, wrap(async (req, res) => {
  await svc.requestEmailVerification(body(z.object({ email: emailSchema }), req).email);
  res.json({ ok: true });
}));

authRouter.post('/verify-email', authLimiter, wrap(async (req, res) => {
  const b = body(z.object({ email: emailSchema, code: codeSchema }), req);
  await svc.verifyEmail(b.email, b.code);
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireAuth, wrap(async (req, res) => {
  const { user, sessionId } = authed(req);
  res.json({ sessions: await svc.listSessions(user.id, sessionId) });
}));

authRouter.delete('/sessions/:id', requireAuth, wrap(async (req, res) => {
  if (!(await svc.revokeSession(authed(req).user.id, String(req.params.id)))) throw notFound('Session introuvable');
  res.status(204).end();
}));
