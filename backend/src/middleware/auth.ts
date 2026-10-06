import type { NextFunction, Request, Response } from 'express';
import type { User } from '@prisma/client';
import { prisma } from '../config/db';
import { forbidden, unauthorized } from '../utils/errors';
import { verifyAccessToken } from '../utils/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: { user: User; sessionId: string } }
  }
}

/** Exige un jeton d'accès valide, une session non révoquée et un compte actif. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw unauthorized();
    const claims = verifyAccessToken(token);
    if (!claims) throw unauthorized('TOKEN_INVALID', 'Session expirée ou invalide');
    const session = await prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== claims.sub) {
      throw unauthorized('SESSION_REVOKED', 'Session expirée ou révoquée');
    }
    if (session.user.status !== 'ACTIVE') throw forbidden('ACCOUNT_NOT_ACTIVE', 'Ce compte est suspendu ou désactivé');
    req.auth = { user: session.user, sessionId: session.id };
    next();
  } catch (e) {
    next(e);
  }
}

export const authed = (req: Request) => req.auth!;
