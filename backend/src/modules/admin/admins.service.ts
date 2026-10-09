import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { conflict, notFound } from '../../utils/errors';
import { type AdminCandidate, type Role, isCatalogKey } from './permissions';
import { can, refuse, requirePermission, roleFor } from './roles';

const isSuper = (u: AdminCandidate) => roleFor(u) === 'SUPER_ADMIN';
const json = (v: unknown) => v as Prisma.InputJsonValue;

const SELECT_ADMIN = {
  id: true, username: true, displayName: true, email: true, adminRole: true, adminStatus: true,
  mustChangePassword: true, createdAt: true, permissionGrants: { select: { permission: true } },
} as const;

export async function listAdmins(actor: AdminCandidate) {
  requirePermission(actor, 'admins.view');
  return prisma.user.findMany({
    where: { adminRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }, orderBy: { updatedAt: 'desc' }, take: 200, select: SELECT_ADMIN,
  });
}

/** Fiche d'un administrateur : permissions accordées et historique de ses décisions. */
export async function getAdmin(actor: AdminCandidate, id: string) {
  requirePermission(actor, 'admins.view');
  const admin = await prisma.user.findUnique({ where: { id }, select: SELECT_ADMIN });
  if (!admin || admin.adminRole === 'USER' || admin.adminRole === null) throw notFound('Administrateur introuvable');
  const history = await prisma.adminAuditLog.findMany({
    where: { targetType: 'ADMIN', targetId: id }, orderBy: { createdAt: 'desc' }, take: 50,
    include: { admin: { select: { id: true, username: true, displayName: true } } },
  });
  return { admin, history };
}

/** Création d'un compte administrateur avec un mot de passe initial : changement obligatoire à la première connexion. */
export async function createAdmin(actor: AdminCandidate, input: {
  username: string; email: string; displayName: string; password: string; role: 'ADMIN' | 'SUPER_ADMIN'; permissions: string[]; reason: string;
}) {
  requirePermission(actor, 'admins.create');
  if (input.role === 'SUPER_ADMIN' && !isSuper(actor)) {
    refuse(actor, 'SUPER_ADMIN_REQUIRED', 'Seul un super administrateur peut créer un super administrateur', 'admins.create', 'Création de super administrateur sans être super administrateur');
  }
  const perms = input.role === 'SUPER_ADMIN' ? [] : [...new Set(input.permissions)];
  if (!perms.every(isCatalogKey)) throw conflict('UNKNOWN_PERMISSION', 'Permission inconnue');
  if (!isSuper(actor) && !perms.every((p) => isCatalogKey(p) && can(actor, p))) {
    refuse(actor, 'PERMISSION_NOT_HELD', 'Vous ne pouvez accorder que les permissions que vous possédez', 'admins.permissions.update', 'Attribution d’une permission non détenue');
  }
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_COST);
  const username = input.username.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username, email, displayName: input.displayName.trim(), passwordHash, status: 'ACTIVE',
          adminRole: input.role, adminStatus: 'ACTIVE', mustChangePassword: true, emailVerifiedAt: new Date(),
        },
      });
      if (perms.length) await tx.adminPermissionGrant.createMany({ data: perms.map((p) => ({ userId: user.id, permission: p, grantedById: actor.id })) });
      await tx.adminAuditLog.create({
        data: {
          adminId: actor.id, action: 'ADMIN_ACCOUNT_CREATE', targetType: 'ADMIN', targetId: user.id, reason: input.reason,
          module: 'admins', result: 'SUCCESS', newValue: json({ username, role: input.role, permissions: perms }),
        },
      });
      return user;
    });
    return { id: created.id, username, role: input.role, permissions: perms };
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw conflict('ACCOUNT_EXISTS', 'Ce nom d’utilisateur ou cet e-mail est déjà utilisé');
    throw e;
  }
}

/** Suspendre, désactiver ou réactiver un administrateur. Désactiver révoque ses sessions. */
export async function setAdminStatus(actor: AdminCandidate, id: string, input: { status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED'; reason: string }) {
  requirePermission(actor, 'admins.deactivate');
  if (id === actor.id) refuse(actor, 'CANNOT_MODIFY_SELF', 'Un administrateur ne peut pas modifier son propre statut', 'admins.deactivate', 'Auto-modification refusée');
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, adminRole: true, adminStatus: true } });
  if (!target || !target.adminRole || target.adminRole === 'USER') throw notFound('Administrateur introuvable');
  if (target.adminRole === 'SUPER_ADMIN' && !isSuper(actor)) {
    refuse(actor, 'SUPER_ADMIN_REQUIRED', 'Seul un super administrateur peut modifier un autre super administrateur', 'admins.deactivate', 'Action sur un super administrateur');
  }
  if (target.adminRole === 'SUPER_ADMIN' && input.status !== 'ACTIVE') {
    const activeSupers = await prisma.user.count({ where: { adminRole: 'SUPER_ADMIN', OR: [{ adminStatus: 'ACTIVE' }, { adminStatus: null }] } });
    if (activeSupers <= 1) refuse(actor, 'LAST_SUPER_ADMIN', 'Impossible de suspendre le dernier super administrateur', 'admins.deactivate', 'Dernier super administrateur');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { adminStatus: input.status } });
    if (input.status !== 'ACTIVE') await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.adminAuditLog.create({
      data: {
        adminId: actor.id, action: 'ADMIN_STATUS_CHANGE', targetType: 'ADMIN', targetId: id, reason: input.reason,
        module: 'admins', result: 'SUCCESS', oldValue: json({ status: target.adminStatus ?? 'ACTIVE' }), newValue: json({ status: input.status }),
      },
    });
  });
  return { id, status: input.status };
}

/** Remplace les permissions d'un administrateur. Un administrateur n'accorde que ce qu'il possède lui-même. */
export async function setAdminPermissions(actor: AdminCandidate, id: string, input: { permissions: string[]; reason: string }) {
  requirePermission(actor, 'admins.permissions.update');
  if (id === actor.id) refuse(actor, 'CANNOT_MODIFY_SELF', 'Un administrateur ne peut pas modifier ses propres permissions', 'admins.permissions.update', 'Auto-modification refusée');
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, adminRole: true, permissionGrants: { select: { permission: true } } } });
  if (!target || !target.adminRole || target.adminRole === 'USER') throw notFound('Administrateur introuvable');
  if (target.adminRole === 'SUPER_ADMIN') refuse(actor, 'SUPER_ADMIN_HAS_ALL', 'Un super administrateur possède déjà toutes les permissions', 'admins.permissions.update', 'Modification des permissions d’un super administrateur');
  const wanted = [...new Set(input.permissions)];
  if (!wanted.every(isCatalogKey)) throw conflict('UNKNOWN_PERMISSION', 'Permission inconnue');
  if (!isSuper(actor) && !wanted.every((p) => isCatalogKey(p) && can(actor, p))) {
    refuse(actor, 'PERMISSION_NOT_HELD', 'Vous ne pouvez accorder que les permissions que vous possédez', 'admins.permissions.update', 'Attribution d’une permission non détenue');
  }
  const before = target.permissionGrants.map((g) => g.permission).sort();
  const after: string[] = [...wanted].sort();
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  await prisma.$transaction(async (tx) => {
    if (removed.length) await tx.adminPermissionGrant.deleteMany({ where: { userId: id, permission: { in: removed } } });
    if (added.length) await tx.adminPermissionGrant.createMany({ data: added.map((p) => ({ userId: id, permission: p, grantedById: actor.id })) });
    await tx.adminAuditLog.create({
      data: {
        adminId: actor.id, action: 'ADMIN_PERMISSIONS_CHANGE', targetType: 'ADMIN', targetId: id, reason: input.reason,
        module: 'admins', result: 'SUCCESS', oldValue: json(before), newValue: json(after),
      },
    });
  });
  return { id, permissions: after, added, removed };
}

/** Changer le rôle : super administrateur seulement. Un rôle USER retire aussi toutes les permissions. */
export async function setAdminRole(actor: AdminCandidate, id: string, input: { role: Role; reason: string }) {
  requirePermission(actor, 'admins.update');
  if (!isSuper(actor)) refuse(actor, 'SUPER_ADMIN_REQUIRED', 'Seul un super administrateur peut modifier un rôle', 'admins.update', 'Changement de rôle sans être super administrateur');
  if (id === actor.id) refuse(actor, 'CANNOT_MODIFY_SELF', 'Un administrateur ne peut pas modifier son propre rôle', 'admins.update', 'Auto-modification du rôle');
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true, adminRole: true } });
  if (!target || target.status === 'DELETED') throw notFound('Utilisateur introuvable');
  const from: Role = target.adminRole ?? 'USER';
  if (from === input.role) return { id, role: input.role, from, changed: false };
  if (from === 'SUPER_ADMIN' && input.role !== 'SUPER_ADMIN') {
    const activeSupers = await prisma.user.count({ where: { adminRole: 'SUPER_ADMIN', OR: [{ adminStatus: 'ACTIVE' }, { adminStatus: null }] } });
    if (activeSupers <= 1) refuse(actor, 'LAST_SUPER_ADMIN', 'Impossible de retirer le dernier super administrateur', 'admins.update', 'Dernier super administrateur');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { adminRole: input.role, adminStatus: input.role === 'USER' ? null : 'ACTIVE' } });
    if (input.role === 'USER') await tx.adminPermissionGrant.deleteMany({ where: { userId: id } });
    await tx.adminAuditLog.create({
      data: {
        adminId: actor.id, action: 'ADMIN_ROLE_CHANGE', targetType: 'USER', targetId: id, reason: input.reason,
        module: 'admins', result: 'SUCCESS', oldValue: json({ role: from }), newValue: json({ role: input.role }),
      },
    });
  });
  return { id, role: input.role, from, changed: true };
}
