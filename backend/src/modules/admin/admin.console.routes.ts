import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authed, requireAuth } from '../../middleware/auth';
import { wrap } from '../../utils/async';
import { parse } from '../../utils/validate';
import { CATALOG, FAMILIES, PRESETS, effectivePermissions } from './permissions';
import * as admins from './admins.service';
import { legacyLists, permissionGuard, roleFor } from './roles';

/** Console d'administration : profil, catalogue, administrateurs, Lives, créateurs, journal. Chaque route exige sa permission. */
export const adminConsoleRouter = Router();
adminConsoleRouter.use(requireAuth);
const me = (req: Parameters<typeof authed>[0]) => authed(req).user;
const limit = z.coerce.number().int().min(1).max(100).default(50);
const reason = z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300);
const permissionList = z.array(z.string().max(80)).max(80);

adminConsoleRouter.get('/me', wrap(async (req, res) => {
  const u = me(req);
  res.json({
    role: roleFor(u), status: u.adminStatus ?? null, mustChangePassword: !!u.mustChangePassword,
    permissions: effectivePermissions(u, legacyLists()),
  });
}));

adminConsoleRouter.get('/permissions', permissionGuard('admins.view'), wrap(async (_req, res) => {
  res.json({
    families: Object.entries(FAMILIES).map(([id, label]) => ({
      id, label, permissions: CATALOG.filter((c) => c.family === id).map((c) => ({ key: c.key, label: c.label })),
    })),
    presets: PRESETS,
  });
}));

adminConsoleRouter.get('/admins', permissionGuard('admins.view'), wrap(async (req, res) => {
  res.json({ admins: await admins.listAdmins(me(req)) });
}));
adminConsoleRouter.get('/admins/:userId', permissionGuard('admins.view'), wrap(async (req, res) => {
  res.json(await admins.getAdmin(me(req), String(req.params.userId)));
}));

const createBody = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9_.-]{3,30}$/, 'Nom d’utilisateur invalide (3 à 30 caractères)'),
  email: z.string().trim().email().max(190),
  displayName: z.string().trim().min(2).max(60),
  password: z.string().min(12, 'Mot de passe initial : 12 caractères minimum').max(128),
  role: z.enum(['ADMIN', 'SUPER_ADMIN']),
  permissions: permissionList.default([]),
  reason,
}).strict();
adminConsoleRouter.post('/admins', permissionGuard('admins.create'), wrap(async (req, res) => {
  res.status(201).json(await admins.createAdmin(me(req), parse(createBody, req.body)));
}));

const statusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']), reason }).strict();
adminConsoleRouter.patch('/admins/:userId/status', permissionGuard('admins.deactivate'), wrap(async (req, res) => {
  res.json(await admins.setAdminStatus(me(req), String(req.params.userId), parse(statusBody, req.body)));
}));

const permissionsBody = z.object({ permissions: permissionList, reason }).strict();
adminConsoleRouter.put('/admins/:userId/permissions', permissionGuard('admins.permissions.update'), wrap(async (req, res) => {
  res.json(await admins.setAdminPermissions(me(req), String(req.params.userId), parse(permissionsBody, req.body)));
}));

const roleBody = z.object({ role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']), reason }).strict();
adminConsoleRouter.patch('/admins/:userId/role', permissionGuard('admins.update'), wrap(async (req, res) => {
  res.json(await admins.setAdminRole(me(req), String(req.params.userId), parse(roleBody, req.body)));
}));

const livesQuery = z.object({ status: z.string().max(20).optional(), limit }).strict();
adminConsoleRouter.get('/lives', permissionGuard('moderation.lives.view'), wrap(async (req, res) => {
  const q = parse(livesQuery, req.query);
  const lives = await prisma.live.findMany({
    where: q.status ? { status: q.status as never } : {},
    orderBy: { createdAt: 'desc' }, take: q.limit,
    select: {
      id: true, title: true, status: true, moderationStatus: true, startedAt: true, endedAt: true, uniqueViewers: true, peakViewers: true,
      host: { select: { id: true, username: true, displayName: true, certificationStatus: true } },
    },
  });
  res.json({ lives });
}));

const creatorsQuery = z.object({ q: z.string().trim().max(60).optional(), limit }).strict();
adminConsoleRouter.get('/creators', permissionGuard('creators.view'), wrap(async (req, res) => {
  const q = parse(creatorsQuery, req.query);
  const where = {
    isCreator: true,
    ...(q.q ? { OR: [{ username: { contains: q.q, mode: 'insensitive' as const } }, { displayName: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
  };
  const creators = await prisma.user.findMany({
    where, orderBy: { createdAt: 'desc' }, take: q.limit,
    select: { id: true, username: true, displayName: true, status: true, certificationStatus: true, monetizationDisabledAt: true, emailVerifiedAt: true },
  });
  res.json({ creators });
}));

const auditQuery = z.object({
  action: z.string().max(80).optional(), adminId: z.string().max(60).optional(), targetType: z.string().max(40).optional(),
  targetId: z.string().max(60).optional(), module: z.string().max(40).optional(),
  result: z.enum(['SUCCESS', 'REFUSED', 'ERROR']).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), cursor: z.string().max(60).optional(), limit,
}).strict();
adminConsoleRouter.get('/audit', permissionGuard('audit.view'), wrap(async (req, res) => {
  const q = parse(auditQuery, req.query);
  const dates = q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {};
  const rows = await prisma.adminAuditLog.findMany({
    where: {
      ...(q.action ? { action: { contains: q.action } } : {}),
      ...(q.adminId ? { adminId: q.adminId } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.module ? { module: q.module } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...dates,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: { admin: { select: { id: true, username: true, displayName: true } } },
  });
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
}));
