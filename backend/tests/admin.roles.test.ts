import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };

/** Compte administrateur actif, avec les permissions données. */
const adminWith = async (n: number, permissions: string[], adminRole: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN') => {
  const s: S = await signedIn(n);
  await prisma.user.update({ where: { id: s.user.id }, data: { adminRole, adminStatus: 'ACTIVE' } });
  if (permissions.length) await prisma.adminPermissionGrant.createMany({ data: permissions.map((p) => ({ userId: s.user.id, permission: p, grantedById: s.user.id })) });
  return s;
};

describe('étape 7 — permissions individuelles', () => {
  it('un administrateur sans permission de paiements est refusé sur les retraits, et le refus est journalisé', async () => {
    const admin = await adminWith(1, ['finance.transactions.view']);
    expect((await api().get('/api/admin/withdrawals').set(admin.auth)).status).toBe(403);
    const refused = await prisma.adminAuditLog.findFirst({ where: { adminId: admin.user.id, result: 'REFUSED' } });
    expect(refused).toMatchObject({ module: 'finance' });
  });

  it('une permission de lecture n’ouvre pas la modification', async () => {
    const admin = await adminWith(1, ['finance.withdrawals.view']);
    expect((await api().get('/api/admin/withdrawals').set(admin.auth)).status).toBe(200);
    expect((await api().patch('/api/admin/withdrawals/x').set(admin.auth).send({ status: 'PROCESSING', reason: 'Test de permission' })).status).toBe(403);
  });

  it('un administrateur ne peut accorder que les permissions qu’il possède', async () => {
    const manager = await adminWith(1, ['admins.permissions.update']);
    const target = await adminWith(2, []);
    const r = await api().put(`/api/admin/admins/${target.user.id}/permissions`).set(manager.auth).send({ permissions: ['finance.commissions.update'], reason: 'Accorder les commissions' });
    expect(r.status).toBe(403);
  });

  it('le super administrateur crée un administrateur ; le mot de passe initial n’est jamais renvoyé et le changement est exigé', async () => {
    const root = await adminWith(1, [], 'SUPER_ADMIN');
    const r = await api().post('/api/admin/admins').set(root.auth).send({
      username: 'support_amina', email: 'amina@example.test', displayName: 'Amina', password: 'mot-de-passe-initial-1',
      role: 'ADMIN', permissions: ['finance.transactions.view'], reason: 'Nouvelle équipe finance',
    });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.body)).not.toContain('mot-de-passe-initial-1');
    const created = await prisma.user.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(created).toMatchObject({ adminRole: 'ADMIN', adminStatus: 'ACTIVE', mustChangePassword: true });
  });

  it('un administrateur ne peut pas modifier son propre statut ni celui d’un super administrateur', async () => {
    const admin = await adminWith(1, ['admins.deactivate']);
    expect((await api().patch(`/api/admin/admins/${admin.user.id}/status`).set(admin.auth).send({ status: 'SUSPENDED', reason: 'Auto-suspension' })).status).toBe(403);
    const root = await adminWith(2, [], 'SUPER_ADMIN');
    expect((await api().patch(`/api/admin/admins/${root.user.id}/status`).set(admin.auth).send({ status: 'SUSPENDED', reason: 'Suspension test' })).status).toBe(403);
  });

  it('désactiver un administrateur révoque sa session : il perd l’accès à la requête suivante', async () => {
    const root = await adminWith(1, [], 'SUPER_ADMIN');
    const target = await adminWith(2, ['stats.view']);
    expect((await api().get('/api/admin/me').set(target.auth)).status).toBe(200);
    expect((await api().patch(`/api/admin/admins/${target.user.id}/status`).set(root.auth).send({ status: 'DISABLED', reason: 'Fin de mission' })).status).toBe(200);
    expect((await api().get('/api/admin/me').set(target.auth)).status).toBe(401);
  });

  it('le dernier super administrateur ne peut pas être suspendu', async () => {
    const root = await adminWith(1, [], 'SUPER_ADMIN');
    const other = await adminWith(2, [], 'SUPER_ADMIN');
    await prisma.user.update({ where: { id: other.user.id }, data: { adminRole: 'ADMIN' } });
    expect((await api().patch(`/api/admin/admins/${root.user.id}/status`).set(root.auth).send({ status: 'SUSPENDED', reason: 'Dernier super admin' })).status).toBe(403);
  });

  it('un mot de passe initial oblige à changer de mot de passe : seul /me reste accessible', async () => {
    const admin = await adminWith(1, ['finance.transactions.view']);
    await prisma.user.update({ where: { id: admin.user.id }, data: { mustChangePassword: true } });
    expect((await api().get('/api/admin/transactions').set(admin.auth)).status).toBe(403);
    expect((await api().get('/api/admin/me').set(admin.auth)).status).toBe(200);
  });

  it('le journal filtre par résultat : seules les tentatives refusées sont renvoyées', async () => {
    const root = await adminWith(2, [], 'SUPER_ADMIN');
    const ok = await api().get('/api/admin/audit?result=REFUSED').set(root.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.items.every((i: { result: string }) => i.result === 'REFUSED')).toBe(true);
  });
});
