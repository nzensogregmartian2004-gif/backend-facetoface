import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { randomToken, sha256 } from './crypto';

export type AccessClaims = { sub: string; sid: string };

export const signAccessToken = (c: AccessClaims) =>
  jwt.sign(c, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL_SECONDS });

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    return typeof p.sub === 'string' && typeof p.sid === 'string' ? { sub: p.sub, sid: p.sid } : null;
  } catch {
    return null;
  }
}

/** Jeton de rafraîchissement opaque : `<sessionId>.<secret>`. Seul le hash du secret est stocké. */
export function newRefreshSecret() {
  const secret = randomToken(48);
  return { secret, hash: sha256(secret) };
}
export const formatRefreshToken = (sessionId: string, secret: string) => `${sessionId}.${secret}`;
export function splitRefreshToken(t: string): { sessionId: string; secret: string } | null {
  const i = t.indexOf('.');
  if (i < 1 || i === t.length - 1) return null;
  return { sessionId: t.slice(0, i), secret: t.slice(i + 1) };
}
