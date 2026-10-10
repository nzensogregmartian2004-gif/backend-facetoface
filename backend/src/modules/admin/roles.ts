import type { RequestHandler } from 'express';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { forbidden } from '../../utils/errors';
import {
  type AdminCandidate, type AdminPermission, type LegacyLists, type Role,
  canAct, familyOf, permissionForAdminPath, roleFor as pureRoleFor,
} from './permissions';

const split = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

/** Seule ADMIN_USER_IDS reste honorée, comme repli de super administrateur pendant la transition. */
export function legacyLists(): LegacyLists {
  return { superAdmins: split(env.ADMIN_USER_IDS), admins: [] };
}
export function roleFor(u: AdminCandidate): Role { return pureRoleFor(u, legacyLists()); }
export function can(u: AdminCandidate, p: AdminPermission): boolean { return canAct(u, p, legacyLists()); }

/** Écrit l'entrée de refus et attend son enregistrement : la réponse ne part qu'après. Une erreur d'écriture est signalée, jamais avalée. */
export async function writeRefusal(actorId: string, p: AdminPermission, reason: string, ctx?: { method?: string; path?: string }): Promise<void> {
  const module = p === 'admin.access' ? 'admin' : familyOf(p);
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId: actorId, action: 'ACCESS_DENIED', targetType: module.toUpperCase(), targetId: ctx?.path ?? '',
        reason, module, result: 'REFUSED',
        metadata: { permission: p, method: ctx?.method ?? null, path: ctx?.path ?? null },
      },
    });
  } catch (e) {
    console.error('[admin] journal de refus impossible', e);
  }
}

/** Journalise un refus sans attendre (appels synchrones existants). Préférer writeRefusal quand on peut attendre. */
export function logRefusal(actorId: string, p: AdminPermission, reason: string, ctx?: { method?: string; path?: string }) {
  void writeRefusal(actorId, p, reason, ctx);
}

/** Exige une permission. Un refus est journalisé avant d'être renvoyé. */
export function requirePermission(u: AdminCandidate, p: AdminPermission, ctx?: { method?: string; path?: string }): void {
  if (can(u, p)) return;
  const staff = roleFor(u) !== 'USER';
  logRefusal(u.id, p, staff ? `Permission manquante : ${p}` : 'Accès à l’administration refusé (compte non administrateur)', ctx);
  throw staff
    ? forbidden('PERMISSION_DENIED', 'Permission refusée')
    : forbidden('ADMIN_REQUIRED', 'Droits administrateur requis');
}

/** Refus métier (auto-modification, dernier super administrateur…), journalisé puis renvoyé. */
export function refuse(u: AdminCandidate, code: string, message: string, p: AdminPermission | null, reason: string): never {
  logRefusal(u.id, p ?? 'admin.access', reason);
  throw forbidden(code, message);
}

const actorOf = (req: unknown): AdminCandidate => (req as { auth: { user: AdminCandidate } }).auth.user;

/** Garde appliquée à toute requête /api/admin : la permission dépend de la route et de la méthode. */
export const gateAdminRoute: RequestHandler = async (req, _res, next) => {
  try {
    const user = actorOf(req);
    const ctx = { method: req.method, path: req.path };
    const staff = roleFor(user) !== 'USER';
    if (staff && user.adminStatus && user.adminStatus !== 'ACTIVE') {
      await writeRefusal(user.id, 'admin.access', `Compte administrateur ${user.adminStatus.toLowerCase()}`, ctx);
      throw forbidden('ADMIN_ACCOUNT_INACTIVE', 'Ce compte administrateur est suspendu ou désactivé');
    }
    if (staff && user.mustChangePassword && req.path !== '/me') {
      throw forbidden('PASSWORD_CHANGE_REQUIRED', 'Changez votre mot de passe avant de continuer');
    }
    const perm = permissionForAdminPath(req.method, req.path);
    if (!can(user, perm)) {
      await writeRefusal(user.id, perm, staff ? `Permission manquante : ${perm}` : 'Accès à l’administration refusé (compte non administrateur)', ctx);
      throw staff ? forbidden('PERMISSION_DENIED', 'Permission refusée') : forbidden('ADMIN_REQUIRED', 'Droits administrateur requis');
    }
    next();
  } catch (e) { next(e); }
};

/** Garde d'une permission donnée, pour une route précise. */
export const permissionGuard = (p: AdminPermission): RequestHandler => (req, _res, next) => {
  try { requirePermission(actorOf(req), p); next(); } catch (e) { next(e); }
};

/** Routes qui écrivent déjà leur propre audit métier : seul le succès n'est pas doublé. */
const SELF_AUDITED = ['/coins', '/certification', '/config', '/disputes', '/admins'];

/** Toute mutation d'un administrateur est journalisée : succès, ou erreur. Les refus sont journalisés par requirePermission. */
export const auditAdminMutations: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode === 403) return;
    const user = (req as unknown as { auth?: { user?: { id: string } } }).auth?.user;
    if (!user) return;
    if (SELF_AUDITED.some((p) => req.path === p || req.path.startsWith(p + '/')) && res.statusCode < 400) return;
    const parts = req.path.split('/').filter(Boolean);
    const route = (req as unknown as { route?: { path?: string } }).route?.path ?? req.path;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
    prisma.adminAuditLog.create({
      data: {
        adminId: user.id, action: `${req.method} ${route}`, targetType: (parts[0] ?? 'ADMIN').toUpperCase(), targetId: parts[1] ?? '',
        reason, module: familyOf(permissionForAdminPath(req.method, req.path)),
        result: res.statusCode < 400 ? 'SUCCESS' : 'ERROR',
        metadata: { status: res.statusCode, fields: Object.keys(req.body ?? {}).slice(0, 20) },
      },
    }).catch(() => undefined);
  });
  next();
};

/** Contexte d'un compte par identifiant, pour les services qui ne reçoivent que l'identifiant. */
export async function actorById(id: string): Promise<AdminCandidate> {
  const u = await prisma.user.findUnique({
    where: { id },
    select: { id: true, adminRole: true, adminStatus: true, mustChangePassword: true, permissionGrants: { select: { permission: true } } },
  });
  if (!u) return { id, adminRole: 'USER' };
  return { id: u.id, adminRole: u.adminRole, adminStatus: u.adminStatus, mustChangePassword: u.mustChangePassword, adminPermissions: u.permissionGrants.map((g) => g.permission) };
}
export async function userCan(id: string, p: AdminPermission): Promise<boolean> { return can(await actorById(id), p); }
export async function isStaffAccount(id: string): Promise<boolean> { return roleFor(await actorById(id)) !== 'USER'; }
export async function accountRole(id: string): Promise<Role> { return roleFor(await actorById(id)); }

/**
 * Initialisation des rôles depuis ADMIN_USER_IDS (super administrateur), idempotente :
 * ne modifie que les comptes sans rôle renseigné.
 */
export async function initAdminRolesFromEnv(): Promise<{ superAdmins: number }> {
  let superAdmins = 0;
  for (const id of legacyLists().superAdmins) {
    superAdmins += (await prisma.user.updateMany({ where: { id, adminRole: null }, data: { adminRole: 'SUPER_ADMIN', adminStatus: 'ACTIVE' } })).count;
  }
  return { superAdmins };
}

/**
 * Contrôles de compte pour les routes d'administration hors /api/admin (publicité, Premium) :
 * compte actif et sans mot de passe provisoire, comme gateAdminRoute. Un compte non administrateur
 * passe ici puis est refusé par la permission demandée.
 */
export async function assertAdminAccountUsable(user: AdminCandidate, ctx?: { method?: string; path?: string }): Promise<void> {
  const staff = roleFor(user) !== 'USER';
  if (staff && user.adminStatus && user.adminStatus !== 'ACTIVE') {
    await writeRefusal(user.id, 'admin.access', `Compte administrateur ${user.adminStatus.toLowerCase()}`, ctx);
    throw forbidden('ADMIN_ACCOUNT_INACTIVE', 'Ce compte administrateur est suspendu ou désactivé');
  }
  if (staff && user.mustChangePassword) throw forbidden('PASSWORD_CHANGE_REQUIRED', 'Changez votre mot de passe avant de continuer');
}

/** Garde d'une permission donnée, pour une route hors /api/admin. */
export const adminPermissionGuard = (p: AdminPermission): RequestHandler => async (req, _res, next) => {
  try {
    const user = actorOf(req);
    const ctx = { method: req.method, path: req.path };
    await assertAdminAccountUsable(user, ctx);
    requirePermission(user, p, ctx);
    next();
  } catch (e) { next(e); }
};

/** Garde de compte administrateur sans permission précise : le service vérifie ensuite chaque permission. */
export const adminAccountGuard: RequestHandler = async (req, _res, next) => {
  try {
    await assertAdminAccountUsable(actorOf(req), { method: req.method, path: req.path });
    next();
  } catch (e) { next(e); }
};

/** Garde qui accepte l'une ou l'autre des permissions données. */
export const anyPermissionGuard = (ps: readonly AdminPermission[]): RequestHandler => async (req, _res, next) => {
  try {
    const user = actorOf(req);
    const ctx = { method: req.method, path: req.path };
    await assertAdminAccountUsable(user, ctx);
    if (ps.some((p) => can(user, p))) { next(); return; }
    requirePermission(user, ps[0], ctx);
    next();
  } catch (e) { next(e); }
};

/** Réservé au super administrateur : bannissement, suppression de compte, retrait de contenu. */
export function requireSuperAdmin(u: AdminCandidate, ctx?: { method?: string; path?: string }): void {
  if (roleFor(u) === 'SUPER_ADMIN') return;
  logRefusal(u.id, 'admin.access', 'Action réservée au super administrateur', ctx);
  throw forbidden('SUPER_ADMIN_REQUIRED', 'Réservé au super administrateur');
}
