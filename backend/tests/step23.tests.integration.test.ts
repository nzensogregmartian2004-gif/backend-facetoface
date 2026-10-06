import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { env } from '../src/config/env';
import { assessActivity } from '../src/modules/fraud/fraud.service';
import { api, creatorSignedIn, publishedContent, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

describe('Étape 23 — tests unitaires / intégration ciblés', () => {
  it('authentification : accès protégé refusé sans session et accepté avec session', async () => {
    const denied = await api().get('/api/users/me');
    expect(denied.status).toBe(401);

    const s = await signedIn(1);
    const ok = await api().get('/api/users/me').set(s.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(s.user.id);
  });

  it('permissions : un utilisateur ne peut pas exécuter une action administrateur', async () => {
    const s = await signedIn(1);
    const res = await api().get('/api/admin/fraud/events').set(s.auth);
    expect(res.status).toBe(403);
  });

  it('anti-fraude : un client automatisé est bloqué et journalisé', async () => {
    const s = await signedIn(1);
    const risk = await assessActivity(s.user.id, 'VIEW', {
      ip: '203.0.113.20',
      userAgent: 'Mozilla/5.0 HeadlessChrome/1.0',
    });

    expect(risk.decision).toBe('BLOCK');
    expect(risk.reason).toContain('AUTOMATED_CLIENT');
    expect(await prisma.fraudEvent.count({ where: { userId: s.user.id, type: 'VIEW' } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } })).fraudStatus).toBe('BLOCKED');
  });

  it('anti-fraude : une vue avec temps de visionnage impossible ne génère pas de vue', async () => {
    const creator = await creatorSignedIn(1);
    const viewer = await signedIn(2);
    const video = await publishedContent(creator.auth, 'VIDEO');

    const before = await prisma.video.findUniqueOrThrow({ where: { id: video.id }, select: { viewCount: true } });
    const res = await api()
      .post(`/api/videos/${video.id}/view`)
      .set(viewer.auth)
      .set('User-Agent', 'Mozilla/5.0')
      .send({ watchedSeconds: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(false);
    expect(res.body.excluded).toBe(true);
    const after = await prisma.video.findUniqueOrThrow({ where: { id: video.id }, select: { viewCount: true } });
    expect(after.viewCount).toBe(before.viewCount);
    expect(await prisma.fraudEvent.count({ where: { userId: viewer.user.id, type: 'VIEW', reason: { contains: 'IMPOSSIBLE_WATCH_TIME' } } })).toBe(1);
  });

  it('stockage vidéo : un brouillon non traité ne peut pas être publié', async () => {
    const creator = await creatorSignedIn(1);
    const draft = await api().post('/api/videos').set(creator.auth).send({ title: 'Test stockage', category: 'music' });
    expect(draft.status).toBe(201);

    const publish = await api().post(`/api/videos/${draft.body.video.id}/publish`).set(creator.auth).send({});
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('modération : le changement anti-fraude administrateur est audité', async () => {
    const admin = await signedIn(1);
    const target = await signedIn(2);
    env.ADMIN_USER_IDS = admin.user.id;

    const res = await api()
      .patch(`/api/admin/fraud/users/${target.user.id}`)
      .set(admin.auth)
      .send({ status: 'REVIEW', reason: 'Activité anormale détectée' });

    expect(res.status).toBe(200);
    expect(res.body.user.fraudStatus).toBe('REVIEW');
    expect(await prisma.adminAuditLog.count({ where: { adminId: admin.user.id, targetId: target.user.id, action: 'FRAUD_STATUS_CHANGE' } })).toBe(1);
  });
});
