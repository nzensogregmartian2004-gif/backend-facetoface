import crypto from 'node:crypto';

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');
/** Code numérique à 6 chiffres (uniformément distribué). */
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export const safeEqual = (a: string, b: string) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

import { env } from '../config/env';
/** HMAC avec le secret serveur : un code à 6 chiffres haché simplement serait trivial à retrouver. */
export const hmac = (v: string) => crypto.createHmac('sha256', env.JWT_SECRET).update(v).digest('hex');
