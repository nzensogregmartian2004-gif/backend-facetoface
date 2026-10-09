import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { api, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

type S = { user: { id: string; username: string }; auth: { Authorization: string } };
const CERT = '/api/admin/certification';
const asAdmin = async () => { const a = await signedIn(1); env.ADMIN_USER_IDS = a.user.id; return a; };
const profileOf = async (viewer: S, username: string) => (await api().get(`/api/users/${username}`).set(viewer.auth)).body.user;
const statusOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { certificationStatus: true } })).certificationStatus;

describe('étape 4 — certification', () => {
  it('un compte ne peut pas se certifier lui-même via PATCH /users/me', async () => {
    const u = await signedIn(2);
    await api().patch('/api/users/me').set(u.auth).send({ certificationStatus: 'CERTIFIED', displayName: 'Nouveau nom' });
    expect(await statusOf(u.user.id)).toBe('NON_CERTIFIED');
  });

  it('certifier puis révoquer : le badge apparaît sur le profil public puis disparaît', async () => {
    const admin = await asAdmin(); const viewer = await signedIn(2); const target = await signedIn(3);
    expect((await api().post(`${CERT}/${target.user.id}/certify`).set(admin.auth).send({})).status).toBe(201);
    expect((await profileOf(viewer, target.user.username)).isCertified).toBe(true);
    expect((await api().post(`${CERT}/${target.user.id}/revoke`).set(admin.auth).send({ reason: 'Usurpation signalée' })).status).toBe(201);
    expect((await profileOf(viewer, target.user.username)).isCertified).toBe(false);
  });

  it('un compte à e-mail vérifié mais non certifié n’affiche aucun badge', async () => {
    const viewer = await signedIn(2); const target = await signedIn(3);
    await prisma.user.update({ where: { id: target.user.id }, data: { emailVerifiedAt: new Date() } });
    expect((await profileOf(viewer, target.user.username)).isCertified).toBe(false);
  });

  it('la révocation exige un motif', async () => {
    const admin = await asAdmin(); const target = await signedIn(3);
    await api().post(`${CERT}/${target.user.id}/certify`).set(admin.auth).send({});
    expect((await api().post(`${CERT}/${target.user.id}/revoke`).set(admin.auth).send({})).status).toBe(400);
    expect(await statusOf(target.user.id)).toBe('CERTIFIED');
  });

  it('un non-administrateur ne peut ni certifier, ni révoquer, ni consulter l’historique', async () => {
    const admin = await asAdmin(); const user = await signedIn(2); const target = await signedIn(3);
    expect((await api().post(`${CERT}/${target.user.id}/certify`).set(user.auth).send({})).status).toBe(403);
    expect((await api().get(`${CERT}/${target.user.id}/history`).set(user.auth)).status).toBe(403);
    expect(await statusOf(target.user.id)).toBe('NON_CERTIFIED');
    expect(admin.user.id).not.toBe(user.user.id);
  });

  it('un administrateur ne peut pas se certifier lui-même', async () => {
    const admin = await asAdmin();
    expect((await api().post(`${CERT}/${admin.user.id}/certify`).set(admin.auth).send({})).status).toBe(403);
  });

  it('certifier un compte déjà certifié est refusé', async () => {
    const admin = await asAdmin(); const target = await signedIn(3);
    await api().post(`${CERT}/${target.user.id}/certify`).set(admin.auth).send({});
    expect((await api().post(`${CERT}/${target.user.id}/certify`).set(admin.auth).send({})).status).toBe(409);
  });

  it('chaque décision est dans l’historique avec administrateur, date et motif', async () => {
    const admin = await asAdmin(); const target = await signedIn(3);
    await api().post(`${CERT}/${target.user.id}/certify`).set(admin.auth).send({ reason: 'Artiste vérifié' });
    await api().post(`${CERT}/${target.user.id}/revoke`).set(admin.auth).send({ reason: 'Compte inactif depuis un an' });
    const h = await api().get(`${CERT}/${target.user.id}/history`).set(admin.auth);
    expect(h.status).toBe(200);
    expect(h.body.events).toHaveLength(2);
    expect(h.body.events.map((e: { action: string }) => e.action)).toEqual(['REVOKE', 'CERTIFY']);
    expect(h.body.events[0].admin.id).toBe(admin.user.id);
    expect(h.body.events[0].reason).toBe('Compte inactif depuis un an');
    expect(await prisma.adminAuditLog.count({ where: { targetId: target.user.id, action: { startsWith: 'CERTIFICATION_' } } })).toBe(2);
  });
});
