import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { testOutbox } from '../src/utils/mailer';
import { api, lastCode, resetDb, signUp, signedIn, validUser } from './helpers';

beforeEach(resetDb);

describe('inscription', () => {
  it('crée un compte, renvoie une session et ne fuit pas le hash', async () => {
    const res = await signUp(1);
    expect(res.status).toBe(201);
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toContain('.');
    expect(res.body.user).toMatchObject({ email: 'user1@example.com', username: 'user_1', isCreator: false, emailVerified: false, birthDate: '1995-06-15' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    const row = await prisma.user.findUnique({ where: { email: 'user1@example.com' } });
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row?.passwordHash).not.toContain('Passw0rd');
  });

  it('normalise e-mail et identifiant en minuscules', async () => {
    const res = await signUp(1, { email: '  USER1@Example.COM ', username: 'User_One' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('user1@example.com');
    expect(res.body.user.username).toBe('user_one');
  });

  it('refuse e-mail et identifiant déjà pris (y compris casse différente)', async () => {
    await signUp(1);
    const a = await signUp(2, { email: 'USER1@example.com' });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('EMAIL_TAKEN');
    const b = await signUp(3, { username: 'USER_1' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('USERNAME_TAKEN');
  });

  it.each([
    ['mot de passe trop court', { password: 'Ab1' }, 'password'],
    ['mot de passe sans chiffre', { password: 'abcdefghij' }, 'password'],
    ['e-mail invalide', { email: 'pas-un-email' }, 'email'],
    ['identifiant réservé', { username: 'admin' }, 'username'],
    ['identifiant avec espace', { username: 'a b c' }, 'username'],
    ['date invalide', { birthDate: '1995-02-31' }, 'birthDate'],
    ['date dans le futur', { birthDate: '2999-01-01' }, 'birthDate'],
    ['mineur sous l’âge minimum', { birthDate: new Date(Date.now() - 10 * 365.25 * 86400000).toISOString().slice(0, 10) }, 'birthDate'],
  ])('valide les champs : %s', async (_n, override, field) => {
    const res = await signUp(1, override);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[field]).toBeTruthy();
    expect(await prisma.user.count()).toBe(0);
  });

  it('envoie un code de vérification par e-mail', async () => {
    await signUp(1);
    expect(lastCode('user1@example.com')).toMatch(/^\d{6}$/);
  });
});

describe('connexion', () => {
  it('connecte par e-mail ou par identifiant', async () => {
    await signUp(1);
    const a = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    expect(a.status).toBe(200);
    const b = await api().post('/api/auth/login').send({ identifier: 'USER_1', password: 'Passw0rdOK' });
    expect(b.status).toBe(200);
    expect(b.body.user.id).toBe(a.body.user.id);
  });

  it('répond identiquement pour un mauvais mot de passe et un compte inconnu', async () => {
    await signUp(1);
    const wrong = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Mauvais123' });
    const unknown = await api().post('/api/auth/login').send({ identifier: 'inconnu@example.com', password: 'Mauvais123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('verrouille le compte après trop d’échecs, même avec le bon mot de passe', async () => {
    await signUp(1);
    for (let i = 0; i < 5; i++) await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Mauvais123' });
    const locked = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    await prisma.user.update({ where: { email: 'user1@example.com' }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const ok = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    expect(ok.status).toBe(200);
  });

  it.each(['SUSPENDED', 'BANNED'] as const)('refuse un compte %s', async (status) => {
    await signUp(1);
    await prisma.user.update({ where: { email: 'user1@example.com' }, data: { status } });
    const res = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(status === 'BANNED' ? 'ACCOUNT_BANNED' : 'ACCOUNT_SUSPENDED');
  });

  it('bloque immédiatement les jetons d’un compte suspendu', async () => {
    const { auth } = await signedIn(1);
    await prisma.user.update({ where: { email: 'user1@example.com' }, data: { status: 'SUSPENDED' } });
    const res = await api().get('/api/users/me').set(auth);
    expect(res.status).toBe(403);
  });
});

describe('sessions et jetons', () => {
  it('protège les routes : sans jeton ou avec un jeton falsifié → 401', async () => {
    expect((await api().get('/api/users/me')).status).toBe(401);
    expect((await api().get('/api/users/me').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });

  it('rafraîchit en faisant tourner le jeton ; l’ancien rejoué révoque toute la session', async () => {
    const { tokens } = await signedIn(1);
    const r1 = await api().post('/api/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.tokens.refreshToken).not.toBe(tokens.refreshToken);
    const ok = await api().get('/api/users/me').set('Authorization', `Bearer ${r1.body.tokens.accessToken}`);
    expect(ok.status).toBe(200);
    // rejeu de l'ancien jeton → détection de vol
    const replay = await api().post('/api/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');
    const newer = await api().post('/api/auth/refresh').send({ refreshToken: r1.body.tokens.refreshToken });
    expect(newer.status).toBe(401);
    const stillAccess = await api().get('/api/users/me').set('Authorization', `Bearer ${r1.body.tokens.accessToken}`);
    expect(stillAccess.status).toBe(401);
  });

  it('rejette un jeton de rafraîchissement mal formé ou au mauvais secret', async () => {
    const { tokens } = await signedIn(1);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: 'nimportequoi-nimportequoi' })).status).toBe(401);
    const id = tokens.refreshToken.split('.')[0];
    expect((await api().post('/api/auth/refresh').send({ refreshToken: `${id}.faux-secret` })).status).toBe(401);
  });

  it('déconnecte : le jeton de rafraîchissement et la session ne fonctionnent plus', async () => {
    const { tokens, auth } = await signedIn(1);
    expect((await api().post('/api/auth/logout').send({ refreshToken: tokens.refreshToken })).status).toBe(204);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: tokens.refreshToken })).status).toBe(401);
    expect((await api().get('/api/users/me').set(auth)).status).toBe(401);
  });

  it('liste les sessions, en révoque une, et logout-all les révoque toutes', async () => {
    const a = await signedIn(1);
    const second = await api().post('/api/auth/login').set('User-Agent', 'Tel 2').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    const list = await api().get('/api/auth/sessions').set(a.auth);
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect((await api().delete(`/api/auth/sessions/${other.id}`).set(a.auth)).status).toBe(204);
    expect((await api().get('/api/users/me').set('Authorization', `Bearer ${second.body.tokens.accessToken}`)).status).toBe(401);
    expect((await api().delete('/api/auth/sessions/inexistante').set(a.auth)).status).toBe(404);
    expect((await api().post('/api/auth/logout-all').set(a.auth)).status).toBe(204);
    expect((await api().get('/api/users/me').set(a.auth)).status).toBe(401);
  });

  it('un utilisateur ne peut pas révoquer la session d’un autre', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    const sid = (await api().get('/api/auth/sessions').set(a.auth)).body.sessions[0].id;
    expect((await api().delete(`/api/auth/sessions/${sid}`).set(b.auth)).status).toBe(404);
    expect((await api().get('/api/users/me').set(a.auth)).status).toBe(200);
  });
});

describe('récupération de compte', () => {
  it('répond pareil pour un compte inconnu et n’envoie rien', async () => {
    await signUp(1);
    const before = testOutbox.length;
    const res = await api().post('/api/auth/forgot-password').send({ email: 'inconnu@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(testOutbox.length).toBe(before);
  });

  it('réinitialise avec le code, révoque les sessions et permet de se reconnecter', async () => {
    const { auth } = await signedIn(1);
    await api().post('/api/auth/forgot-password').send({ email: 'user1@example.com' });
    const code = lastCode('user1@example.com');
    const res = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code, newPassword: 'NouveauPass1' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/users/me').set(auth)).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'NouveauPass1' })).status).toBe(200);
    // le code ne sert qu'une fois
    const again = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code, newPassword: 'Autre12345' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('CODE_INVALID');
  });

  it('refuse un mauvais code, et invalide le code après trop d’essais', async () => {
    await signUp(1);
    await api().post('/api/auth/forgot-password').send({ email: 'user1@example.com' });
    const good = lastCode('user1@example.com');
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code: wrong, newPassword: 'NouveauPass1' });
      expect(r.status).toBe(400);
    }
    const late = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code: good, newPassword: 'NouveauPass1' });
    expect(late.status).toBe(400);
  });

  it('refuse un code expiré', async () => {
    await signUp(1);
    await api().post('/api/auth/forgot-password').send({ email: 'user1@example.com' });
    const code = lastCode('user1@example.com');
    await prisma.oneTimeCode.updateMany({ where: { purpose: 'PASSWORD_RESET' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code, newPassword: 'NouveauPass1' });
    expect(r.status).toBe(400);
  });

  it('un nouveau code invalide le précédent', async () => {
    await signUp(1);
    await api().post('/api/auth/forgot-password').send({ email: 'user1@example.com' });
    const first = lastCode('user1@example.com');
    await api().post('/api/auth/forgot-password').send({ email: 'user1@example.com' });
    const second = lastCode('user1@example.com');
    if (first !== second) {
      const r = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code: first, newPassword: 'NouveauPass1' });
      expect(r.status).toBe(400);
    }
    const ok = await api().post('/api/auth/reset-password').send({ email: 'user1@example.com', code: second, newPassword: 'NouveauPass1' });
    expect(ok.status).toBe(200);
  });
});

describe('changement de mot de passe', () => {
  it('exige le mot de passe actuel, révoque les autres sessions et garde la courante', async () => {
    const a = await signedIn(1);
    const other = await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' });
    const bad = await api().post('/api/auth/change-password').set(a.auth).send({ currentPassword: 'Faux12345', newPassword: 'NouveauPass1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('WRONG_PASSWORD');
    const same = await api().post('/api/auth/change-password').set(a.auth).send({ currentPassword: 'Passw0rdOK', newPassword: 'Passw0rdOK' });
    expect(same.status).toBe(400);
    const ok = await api().post('/api/auth/change-password').set(a.auth).send({ currentPassword: 'Passw0rdOK', newPassword: 'NouveauPass1' });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/users/me').set(a.auth)).status).toBe(200);
    expect((await api().get('/api/users/me').set('Authorization', `Bearer ${other.body.tokens.accessToken}`)).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'NouveauPass1' })).status).toBe(200);
  });
});

describe('vérification de l’e-mail', () => {
  it('vérifie l’adresse avec le code', async () => {
    const { auth } = await signedIn(1);
    expect((await api().get('/api/users/me').set(auth)).body.user.emailVerified).toBe(false);
    const code = lastCode('user1@example.com');
    const bad = await api().post('/api/auth/verify-email').send({ email: 'user1@example.com', code: code === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(400);
    const ok = await api().post('/api/auth/verify-email').send({ email: 'user1@example.com', code });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/users/me').set(auth)).body.user.emailVerified).toBe(true);
  });

  it('permet de redemander un code', async () => {
    await signUp(1);
    await api().post('/api/auth/verify-email/request').send({ email: 'user1@example.com' });
    const code = lastCode('user1@example.com');
    expect((await api().post('/api/auth/verify-email').send({ email: 'user1@example.com', code })).status).toBe(200);
  });
});

describe('format des erreurs', () => {
  it('renvoie du JSON structuré pour un corps invalide et une route inconnue', async () => {
    const bad = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const nf = await api().get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    expect(validUser(1).email).toBeTruthy();
  });
});
