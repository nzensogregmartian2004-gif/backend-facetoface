import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/db';
import { api, resetDb, signedIn } from './helpers';

beforeEach(resetDb);

// PNG 1x1 valide
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('profil', () => {
  it('lit et modifie son profil', async () => {
    const { auth } = await signedIn(1);
    const res = await api().patch('/api/users/me').set(auth).send({ displayName: 'Greg', bio: 'Créateur à Libreville', country: 'ga', links: ['https://example.com/moi'] });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ displayName: 'Greg', bio: 'Créateur à Libreville', country: 'GA', links: ['https://example.com/moi'] });
    const me = await api().get('/api/users/me').set(auth);
    expect(me.body.user.displayName).toBe('Greg');
  });

  it('efface la bio avec une chaîne vide', async () => {
    const { auth } = await signedIn(1);
    await api().patch('/api/users/me').set(auth).send({ bio: 'salut' });
    const res = await api().patch('/api/users/me').set(auth).send({ bio: '' });
    expect(res.body.user.bio).toBeNull();
  });

  it('refuse les champs interdits (e-mail, date de naissance, statut) et les valeurs invalides', async () => {
    const { auth } = await signedIn(1);
    for (const bad of [{ email: 'x@y.com' }, { birthDate: '2000-01-01' }, { status: 'ACTIVE' }, { isCreator: true }, { passwordHash: 'x' }]) {
      expect((await api().patch('/api/users/me').set(auth).send(bad)).status).toBe(400);
    }
    expect((await api().patch('/api/users/me').set(auth).send({})).status).toBe(400);
    expect((await api().patch('/api/users/me').set(auth).send({ bio: 'x'.repeat(301) })).status).toBe(400);
    expect((await api().patch('/api/users/me').set(auth).send({ links: ['javascript:alert(1)'] })).status).toBe(400);
    expect((await api().patch('/api/users/me').set(auth).send({ links: Array(6).fill('https://a.com') })).status).toBe(400);
    expect((await api().patch('/api/users/me').set(auth).send({ country: 'Gabon' })).status).toBe(400);
  });

  it('change d’identifiant, refuse un identifiant déjà pris', async () => {
    const a = await signedIn(1);
    await signedIn(2);
    const taken = await api().patch('/api/users/me').set(a.auth).send({ username: 'user_2' });
    expect(taken.status).toBe(409);
    const ok = await api().patch('/api/users/me').set(a.auth).send({ username: 'Nouveau.Nom' });
    expect(ok.body.user.username).toBe('nouveau.nom');
  });

  it('vérifie la disponibilité d’un identifiant', async () => {
    const { auth } = await signedIn(1);
    expect((await api().get('/api/users/check-username?username=user_2').set(auth)).body.available).toBe(true);
    expect((await api().get('/api/users/check-username?username=user_1').set(auth)).body.available).toBe(true); // le sien
    await signedIn(2);
    expect((await api().get('/api/users/check-username?username=user_2').set(auth)).body.available).toBe(false);
    expect((await api().get('/api/users/check-username?username=admin').set(auth)).status).toBe(400);
  });
});

describe('profil public', () => {
  it('n’expose ni e-mail, ni date de naissance', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    const res = await api().get('/api/users/user_2').set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('user_2');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('user2@example.com');
    expect(text).not.toContain('1995');
    expect(text).not.toContain('passwordHash');
    expect(res.body.user.id).toBe(b.user.id);
  });

  it('exige d’être connecté et renvoie 404 pour un profil inconnu', async () => {
    const { auth } = await signedIn(1);
    expect((await api().get('/api/users/user_1')).status).toBe(401);
    expect((await api().get('/api/users/personne').set(auth)).status).toBe(404);
  });

  it('un profil privé masque bio, pays et liens', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    await api().patch('/api/users/me').set(b.auth).send({ bio: 'secret', country: 'GA', links: ['https://a.com'] });
    await api().patch('/api/users/me/privacy').set(b.auth).send({ profileVisibility: 'PRIVATE' });
    const res = await api().get('/api/users/user_2').set(a.auth);
    expect(res.body.user).toMatchObject({ isPrivate: true, bio: null, country: null, links: [] });
  });

  it('un profil suspendu ou supprimé est introuvable', async () => {
    const a = await signedIn(1);
    await signedIn(2);
    await prisma.user.update({ where: { username: 'user_2' }, data: { status: 'SUSPENDED' } });
    expect((await api().get('/api/users/user_2').set(a.auth)).status).toBe(404);
  });
});

describe('confidentialité', () => {
  it('modifie et valide les réglages', async () => {
    const { auth } = await signedIn(1);
    const res = await api().patch('/api/users/me/privacy').set(auth).send({ allowMessagesFrom: 'NOBODY', showOnlineStatus: false });
    expect(res.body.user.privacy).toEqual({ profileVisibility: 'PUBLIC', allowMessagesFrom: 'NOBODY', showOnlineStatus: false });
    expect((await api().patch('/api/users/me/privacy').set(auth).send({ allowMessagesFrom: 'TOUS' })).status).toBe(400);
    expect((await api().patch('/api/users/me/privacy').set(auth).send({})).status).toBe(400);
  });
});

describe('compte créateur unique', () => {
  it('active et désactive les fonctions créateur sur le même compte (idempotent)', async () => {
    const { auth, user } = await signedIn(1);
    const on = await api().post('/api/users/me/creator/activate').set(auth);
    expect(on.body.user.isCreator).toBe(true);
    expect(on.body.user.id).toBe(user.id);
    expect((await api().post('/api/users/me/creator/activate').set(auth)).body.user.isCreator).toBe(true);
    expect(await prisma.user.count()).toBe(1);
    expect((await api().post('/api/users/me/creator/deactivate').set(auth)).body.user.isCreator).toBe(false);
  });
});

describe('avatar', () => {
  it('envoie une image valide', async () => {
    const { auth } = await signedIn(1);
    const res = await api().put('/api/users/me/avatar').set(auth).attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toMatch(/\/uploads\/avatars\/.+\.png$/);
    const file = new URL(res.body.user.avatarUrl).pathname;
    expect((await api().get(file)).status).toBe(200);
    const removed = await api().delete('/api/users/me/avatar').set(auth);
    expect(removed.body.user.avatarUrl).toBeNull();
    expect((await api().get(file)).status).toBe(404);
  });

  it('refuse un faux fichier image (type MIME mensonger) et l’absence de fichier', async () => {
    const { auth } = await signedIn(1);
    const fake = await api().put('/api/users/me/avatar').set(auth).attach('avatar', Buffer.from('<script>alert(1)</script>'.repeat(5)), { filename: 'a.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('INVALID_IMAGE');
    expect((await api().put('/api/users/me/avatar').set(auth)).status).toBe(400);
  });

  it('refuse un fichier trop gros', async () => {
    const { auth } = await signedIn(1);
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await api().put('/api/users/me/avatar').set(auth).attach('avatar', big, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });
});

describe('blocage', () => {
  it('bloque, liste, débloque ; le bloqué ne voit plus le profil du bloqueur', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    expect((await api().post(`/api/users/${b.user.id}/block`).set(a.auth)).status).toBe(204);
    expect((await api().post(`/api/users/${b.user.id}/block`).set(a.auth)).status).toBe(204); // idempotent
    const list = await api().get('/api/users/me/blocks').set(a.auth);
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0].username).toBe('user_2');
    expect((await api().get('/api/users/user_1').set(b.auth)).status).toBe(404);
    const mine = await api().get('/api/users/user_2').set(a.auth);
    expect(mine.body.user.isBlockedByMe).toBe(true);
    expect((await api().delete(`/api/users/${b.user.id}/block`).set(a.auth)).status).toBe(204);
    expect((await api().get('/api/users/user_1').set(b.auth)).status).toBe(200);
  });

  it('refuse de se bloquer soi-même ou un utilisateur inconnu', async () => {
    const a = await signedIn(1);
    expect((await api().post(`/api/users/${a.user.id}/block`).set(a.auth)).status).toBe(400);
    expect((await api().post('/api/users/inconnu/block').set(a.auth)).status).toBe(404);
  });
});

describe('signalement', () => {
  it('signale un profil, de façon idempotente', async () => {
    const a = await signedIn(1);
    const b = await signedIn(2);
    const payload = { targetType: 'USER', targetId: b.user.id, reason: 'HARASSMENT', details: 'Messages insistants' };
    const r1 = await api().post('/api/moderation/reports').set(a.auth).send(payload);
    expect(r1.status).toBe(201);
    const r2 = await api().post('/api/moderation/reports').set(a.auth).send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.report.id).toBe(r1.body.report.id);
    expect(await prisma.report.count()).toBe(1);
  });

  it('refuse l’auto-signalement, les cibles inconnues, les types non gérés et les motifs invalides', async () => {
    const a = await signedIn(1);
    expect((await api().post('/api/moderation/reports').set(a.auth).send({ targetType: 'USER', targetId: a.user.id, reason: 'SPAM' })).status).toBe(400);
    expect((await api().post('/api/moderation/reports').set(a.auth).send({ targetType: 'USER', targetId: 'inconnu', reason: 'SPAM' })).status).toBe(404);
    const nope = await api().post('/api/moderation/reports').set(a.auth).send({ targetType: 'LIVE', targetId: 'x', reason: 'SPAM' }); // Live signalable depuis l'étape 19 : cible inconnue = 404
    expect(nope.status).toBe(404);
    expect((await api().post('/api/moderation/reports').set(a.auth).send({ targetType: 'USER', targetId: 'x', reason: 'BOF' })).status).toBe(400);
    expect((await api().post('/api/moderation/reports').send({})).status).toBe(401);
  });
});

describe('suppression du compte', () => {
  it('exige le mot de passe, anonymise, révoque et libère e-mail/identifiant', async () => {
    const a = await signedIn(1);
    const wrong = await api().delete('/api/users/me').set(a.auth).send({ password: 'Faux12345' });
    expect(wrong.status).toBe(400);
    expect((await api().delete('/api/users/me').set(a.auth).send({ password: 'Passw0rdOK' })).status).toBe(204);
    expect((await api().get('/api/users/me').set(a.auth)).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ identifier: 'user1@example.com', password: 'Passw0rdOK' })).status).toBe(401);
    const row = await prisma.user.findUnique({ where: { id: a.user.id } });
    expect(row).toMatchObject({ status: 'DELETED', displayName: 'Compte supprimé', bio: null });
    expect(row?.email).not.toContain('user1@');
    // l'e-mail et l'identifiant peuvent être réutilisés
    const again = await api().post('/api/auth/register').send({ email: 'user1@example.com', username: 'user_1', password: 'Passw0rdOK', displayName: 'Nouveau', birthDate: '1990-01-01' });
    expect(again.status).toBe(201);
  });
});
