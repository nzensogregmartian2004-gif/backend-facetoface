import { describe, expect, it } from 'vitest';
import { api, signedIn } from './helpers';

describe('Étape 26 — sécurité', () => {
  it('refuse les accès administrateur aux utilisateurs ordinaires', async () => {
    const user = await signedIn(901);
    expect((await api().get('/api/admin/dashboard').set(user.auth)).status).toBe(403);
    expect((await api().get('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth)).status).toBe(403);
    expect((await api().patch('/api/admin/config/COMMISSION.PLATFORM_PERCENT').set(user.auth).send({ value: 10, reason: 'test' })).status).toBe(403);
  });

  it('rejette les requêtes JSON invalides sans exposer une erreur interne', async () => {
    const response = await api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"identifier":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('ne révèle pas une route webhook quand le secret est invalide', async () => {
    const response = await api().post('/api/webhooks/mypvit/callback/incorrect-secret').send({
      merchantReferenceId: 'unknown',
      status: 'SUCCESS',
      amount: 100,
    });
    expect(response.status).toBe(404);
  });
});
