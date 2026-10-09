import { currencyForCountry } from '../geo/geo.service';
import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { conflict, forbidden, unauthorized, AppError, badRequest } from '../../utils/errors';
import { formatRefreshToken, newRefreshSecret, signAccessToken, splitRefreshToken } from '../../utils/tokens';
import { sha256, safeEqual } from '../../utils/crypto';
import { serializeSelf } from '../../utils/serializers';
import { consumeCode, issueCode } from './codes';

const dummyHash = bcrypt.hashSync('mot-de-passe-factice-pour-egaliser-le-temps', env.BCRYPT_COST);
const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

export type RegisterInput = { email: string; username: string; password: string; displayName: string; birthDate: string; country?: string };

const tokenBundle = (userId: string, sessionId: string, secret: string) => ({
  accessToken: signAccessToken({ sub: userId, sid: sessionId }),
  refreshToken: formatRefreshToken(sessionId, secret),
  expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
});

async function openSession(user: User, req: Request) {
  const { secret, hash } = newRefreshSecret();
  const s = await prisma.session.create({
    data: { userId: user.id, refreshTokenHash: hash, userAgent: req.get('user-agent')?.slice(0, 200) ?? null, ip: req.ip ?? null, expiresAt: refreshExpiry() },
  });
  return tokenBundle(user.id, s.id, secret);
}

const revokeAll = (userId: string, exceptSessionId?: string) =>
  prisma.session.updateMany({ where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, data: { revokedAt: new Date() } });

export async function register(input: RegisterInput, req: Request) {
  const dup = await prisma.user.findFirst({ where: { OR: [{ email: input.email }, { username: input.username }] }, select: { email: true } });
  const takenError = (field: 'email' | 'username') =>
    conflict(field === 'email' ? 'EMAIL_TAKEN' : 'USERNAME_TAKEN', field === 'email' ? 'Cette adresse e-mail est déjà utilisée' : 'Cet identifiant est déjà pris', { [field]: 'Déjà utilisé' });
  if (dup) throw takenError(dup.email === input.email ? 'email' : 'username');

  let user: User;
  try {
    user = await prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        birthDate: new Date(`${input.birthDate}T00:00:00Z`),
        country: input.country ?? null,
        preferredCurrency: currencyForCountry(input.country) ?? undefined,
        passwordHash: await bcrypt.hash(input.password, env.BCRYPT_COST),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = String((e.meta as { target?: unknown })?.target ?? '');
      throw takenError(target.includes('username') ? 'username' : 'email');
    }
    throw e;
  }
  await issueCode(user, 'EMAIL_VERIFICATION');
  if (env.REQUIRE_EMAIL_VERIFICATION) return { user: serializeSelf(user), emailVerificationRequired: true as const };
  return { user: serializeSelf(user), emailVerificationRequired: false as const, tokens: await openSession(user, req) };
}

export async function login(identifier: string, password: string, req: Request) {
  const id = identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: id.includes('@') ? { email: id } : { username: id } });
  const bad = unauthorized('INVALID_CREDENTIALS', 'Identifiants incorrects');
  if (!user || user.status === 'DELETED') { await bcrypt.compare(password, dummyHash); throw bad; }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Trop de tentatives. Réessayez dans quelques minutes ou réinitialisez votre mot de passe.');
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= env.MAX_FAILED_LOGINS;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + env.LOCKOUT_MINUTES * 60_000) : null } });
    throw bad;
  }
  if (user.status === 'BANNED') throw forbidden('ACCOUNT_BANNED', 'Ce compte a été banni');
  if (user.status === 'SUSPENDED') throw forbidden('ACCOUNT_SUSPENDED', 'Ce compte est suspendu');
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) throw forbidden('EMAIL_NOT_VERIFIED', 'Vérifiez votre adresse e-mail pour vous connecter');
  const fresh = await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return { user: serializeSelf(fresh), tokens: await openSession(fresh, req) };
}

export async function refresh(refreshToken: string) {
  const parts = splitRefreshToken(refreshToken);
  const invalid = () => unauthorized('REFRESH_INVALID', 'Session expirée, reconnectez-vous');
  if (!parts) throw invalid();
  const session = await prisma.session.findUnique({ where: { id: parts.sessionId }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw invalid();
  if (!safeEqual(session.refreshTokenHash, sha256(parts.secret))) {
    // Un ancien jeton a été rejoué : on suppose un vol et on révoque toutes les sessions du compte.
    await revokeAll(session.userId);
    throw unauthorized('REFRESH_REUSED', 'Session invalidée par sécurité, reconnectez-vous');
  }
  if (session.user.status !== 'ACTIVE') throw forbidden('ACCOUNT_NOT_ACTIVE', 'Ce compte est suspendu ou désactivé');
  const { secret, hash } = newRefreshSecret();
  const rotated = await prisma.session.updateMany({
    where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
    data: { refreshTokenHash: hash, lastUsedAt: new Date(), expiresAt: refreshExpiry() },
  });
  if (rotated.count !== 1) throw invalid();
  return { user: serializeSelf(session.user), tokens: tokenBundle(session.userId, session.id, secret) };
}

export async function logout(refreshToken: string) {
  const parts = splitRefreshToken(refreshToken);
  if (!parts) return;
  const s = await prisma.session.findUnique({ where: { id: parts.sessionId } });
  if (s && safeEqual(s.refreshTokenHash, sha256(parts.secret))) {
    await prisma.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

export const logoutAll = (userId: string) => revokeAll(userId);

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.status !== 'DELETED') await issueCode(user, 'PASSWORD_RESET');
}

export async function resetPassword(email: string, code: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status === 'DELETED') throw badRequest('CODE_INVALID', 'Code invalide ou expiré');
  await consumeCode(user.id, 'PASSWORD_RESET', code);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, env.BCRYPT_COST), passwordChangedAt: new Date(), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
  });
  await revokeAll(user.id);
}

export async function changePassword(user: User, sessionId: string, currentPassword: string, newPassword: string) {
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest('WRONG_PASSWORD', 'Mot de passe actuel incorrect', { currentPassword: 'Incorrect' });
  if (currentPassword === newPassword) throw badRequest('SAME_PASSWORD', 'Le nouveau mot de passe doit être différent', { newPassword: 'Identique à l’actuel' });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, env.BCRYPT_COST), passwordChangedAt: new Date(), mustChangePassword: false } });
  await revokeAll(user.id, sessionId);
}

export async function requestEmailVerification(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.status !== 'DELETED' && !user.emailVerifiedAt) await issueCode(user, 'EMAIL_VERIFICATION');
}

export async function verifyEmail(email: string, code: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status === 'DELETED') throw badRequest('CODE_INVALID', 'Code invalide ou expiré');
  if (user.emailVerifiedAt) return;
  await consumeCode(user.id, 'EMAIL_VERIFICATION', code);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
}

export async function listSessions(userId: string, currentId: string) {
  const rows = await prisma.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: 'desc' } });
  return rows.map((s) => ({ id: s.id, device: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === currentId }));
}

export async function revokeSession(userId: string, sessionId: string) {
  const r = await prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count === 1;
}
