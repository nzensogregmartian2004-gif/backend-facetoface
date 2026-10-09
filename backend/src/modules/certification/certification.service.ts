import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { conflict, forbidden, notFound } from '../../utils/errors';
import { requirePermission } from '../admin/roles';

export type CertStatus = 'NON_CERTIFIED' | 'PENDING' | 'CERTIFIED' | 'REVOKED';
export type CertAction = 'CERTIFY' | 'REVOKE';

/**
 * Règle de transition, pure et testable : certifier un compte qui ne l'est pas ; révoquer un compte certifié.
 * Renvoie le nouveau statut, ou lève une erreur 409 si la décision n'a pas de sens.
 */
export function nextCertificationStatus(current: CertStatus, action: CertAction): CertStatus {
  if (action === 'CERTIFY') {
    if (current === 'CERTIFIED') throw conflict('ALREADY_CERTIFIED', 'Ce compte est déjà certifié');
    return 'CERTIFIED';
  }
  if (current !== 'CERTIFIED') throw conflict('NOT_CERTIFIED', 'Ce compte n’est pas certifié');
  return 'REVOKED';
}

const summary = (u: { id: string; username: string; displayName: string; avatarUrl: string | null; certificationStatus: CertStatus; certifiedAt: Date | null }) =>
  ({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, certificationStatus: u.certificationStatus, certifiedAt: u.certifiedAt });

const guard = (admin: User, targetId: string) => {
  requirePermission(admin, 'creators.certify');
  if (targetId === admin.id) throw forbidden('SELF_CERTIFICATION', 'Un administrateur ne peut pas modifier sa propre certification');
};

async function change(admin: User, userId: string, action: CertAction, reason: string | null) {
  guard(admin, userId);
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true, certificationStatus: true } });
    if (!target || target.status === 'DELETED') throw notFound('Utilisateur introuvable');
    const next = nextCertificationStatus(target.certificationStatus, action);
    const user = await tx.user.update({
      where: { id: userId },
      data: action === 'CERTIFY'
        ? { certificationStatus: next, certifiedAt: new Date(), certifiedById: admin.id }
        : { certificationStatus: next, certifiedAt: null, certifiedById: null },
    });
    const event = await tx.certificationEvent.create({ data: { userId, adminId: admin.id, action, reason } });
    await tx.adminAuditLog.create({
      data: { adminId: admin.id, action: action === 'CERTIFY' ? 'CERTIFICATION_GRANT' : 'CERTIFICATION_REVOKE', targetType: 'USER', targetId: userId, reason,
        metadata: { from: target.certificationStatus, to: next } },
    });
    return { user: summary(user), event: { id: event.id, action, reason, createdAt: event.createdAt } };
  });
}

export const certify = (admin: User, userId: string, reason: string | null) => change(admin, userId, 'CERTIFY', reason);
export const revoke = (admin: User, userId: string, reason: string) => change(admin, userId, 'REVOKE', reason);

/** Comptes par statut (par défaut : tous ceux qui ont été certifiés ou révoqués), du plus récemment modifié au plus ancien. */
export async function list(admin: User, status?: CertStatus) {
  requirePermission(admin, 'creators.view');
  const rows = await prisma.user.findMany({
    where: { certificationStatus: status ?? { not: 'NON_CERTIFIED' }, status: { not: 'DELETED' } },
    orderBy: { updatedAt: 'desc' }, take: 100,
    select: { id: true, username: true, displayName: true, avatarUrl: true, certificationStatus: true, certifiedAt: true },
  });
  return { items: rows.map(summary) };
}

/** Statut courant d'un compte et historique complet de ses décisions. */
export async function history(admin: User, userId: string) {
  requirePermission(admin, 'creators.view');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, displayName: true, avatarUrl: true, certificationStatus: true, certifiedAt: true } });
  if (!user) throw notFound('Utilisateur introuvable');
  const events = await prisma.certificationEvent.findMany({
    where: { userId }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { admin: { select: { id: true, username: true, displayName: true } } },
  });
  return { user: summary(user), events: events.map((e) => ({ id: e.id, action: e.action, reason: e.reason, createdAt: e.createdAt, admin: e.admin })) };
}
