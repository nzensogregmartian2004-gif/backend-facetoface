import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const make = (windowMs: number, limit: number, code = 'RATE_LIMITED') =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    handler: (_req, res) => res.status(429).json({ error: { code, message: 'Trop de tentatives. Réessayez dans quelques instants.' } }),
  });

export const globalLimiter = make(15 * 60_000, 600);
export const authLimiter = make(15 * 60_000, 30);
export const sensitiveLimiter = make(60 * 60_000, 8); // mot de passe oublié, renvoi de code
export const reportLimiter = make(60 * 60_000, 20);
export const uploadLimiter = make(60 * 60_000, 30);
export const messageLimiter = make(10 * 60_000, 120);
export const unlockLimiter = make(10 * 60_000, 20);
export const contentLimiter = make(60 * 60_000, 60); // création de brouillons, demandes d'envoi
export const commentLimiter = make(10 * 60_000, 30);
export const shareLimiter = make(60 * 60_000, 60);
export const searchLimiter = make(10 * 60_000, 120);

export const paymentLimiter = make(10 * 60_000, 30, 'PAYMENT_RATE_LIMITED');
export const webhookLimiter = make(60 * 60_000, 300, 'WEBHOOK_RATE_LIMITED');
