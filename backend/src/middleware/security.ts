import type { NextFunction, Request, Response } from 'express';
import { env, isProd } from '../config/env';

/** Refuse les requêtes HTTP en production : TLS doit être terminé par le reverse-proxy. */
export function requireHttps(req: Request, res: Response, next: NextFunction) {
  if (!isProd || req.path === '/api/health') return next();
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase();
  const secure = req.secure || (env.TRUST_PROXY && forwarded === 'https');
  if (!secure) {
    return res.status(400).json({ error: { code: 'HTTPS_REQUIRED', message: 'Une connexion HTTPS est requise' } });
  }
  return next();
}

export function corsOrigins() {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined) {
  if (!origin) return true;
  const origins = corsOrigins();
  return origins.length > 0 && origins.includes(origin);
}
