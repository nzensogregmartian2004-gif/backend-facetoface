import { describe, expect, it } from 'vitest';
import { CATALOG, PRESETS, type AdminPermission, canAct, configPermissionFor, effectivePermissions, isCatalogKey, permissionForAdminPath, roleFor } from '../src/modules/admin/permissions';

const LEGACY = { superAdmins: ['root'], admins: [] };

describe('étape 7 — catalogue et modèles', () => {
  it('chaque permission a une clé unique et une famille connue', () => {
    const keys = CATALOG.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(40);
    for (const c of CATALOG) expect(['users', 'moderation', 'support', 'creators', 'finance', 'premium', 'advertising', 'stats', 'admins', 'audit', 'config']).toContain(c.family);
  });
  it('chaque modèle ne contient que des permissions du catalogue', () => {
    for (const preset of PRESETS) for (const p of preset.permissions) expect(isCatalogKey(p)).toBe(true);
  });
});

describe('étape 7 — rôle effectif', () => {
  it('le repli sur ADMIN_USER_IDS donne le super administrateur, un rôle explicite l’emporte', () => {
    expect(roleFor({ id: 'root', adminRole: null }, LEGACY)).toBe('SUPER_ADMIN');
    expect(roleFor({ id: 'root', adminRole: 'ADMIN' }, LEGACY)).toBe('ADMIN');
  });
  it('un rôle USER explicite retire l’accès, même si le compte figure dans ADMIN_USER_IDS', () => {
    expect(roleFor({ id: 'root', adminRole: 'USER' }, LEGACY)).toBe('USER');
    expect(canAct({ id: 'root', adminRole: 'USER' }, 'admin.access', LEGACY)).toBe(false);
  });
});

describe('étape 7 — décision d’accès', () => {
  it('un administrateur n’a que les permissions qui lui sont accordées', () => {
    const admin = { id: 'a', adminRole: 'ADMIN' as const, adminStatus: 'ACTIVE' as const, adminPermissions: ['finance.transactions.view'] };
    expect(canAct(admin, 'finance.transactions.view', LEGACY)).toBe(true);
    expect(canAct(admin, 'finance.commissions.update', LEGACY)).toBe(false);
    expect(canAct(admin, 'admin.access', LEGACY)).toBe(true);
  });
  it('voir un montant n’autorise pas à le modifier : permissions distinctes', () => {
    const viewer = { id: 'v', adminRole: 'ADMIN' as const, adminStatus: 'ACTIVE' as const, adminPermissions: ['finance.revenue.view'] };
    expect(canAct(viewer, 'finance.revenue.view', LEGACY)).toBe(true);
    expect(canAct(viewer, 'finance.premium.prices.update', LEGACY)).toBe(false);
  });
  it('un compte suspendu ou désactivé n’a plus aucune permission, même accordée', () => {
    for (const status of ['SUSPENDED', 'DISABLED'] as const) {
      const a = { id: 'a', adminRole: 'ADMIN' as const, adminStatus: status, adminPermissions: ['stats.view'] };
      expect(canAct(a, 'stats.view', LEGACY)).toBe(false);
      expect(effectivePermissions(a, LEGACY)).toEqual([]);
    }
  });
  it('le super administrateur possède toutes les permissions du catalogue', () => {
    const keys = effectivePermissions({ id: 'root', adminRole: 'SUPER_ADMIN' }, LEGACY);
    for (const c of CATALOG) expect(keys).toContain(c.key);
  });
  it('un compte sans rôle n’a aucune permission', () => {
    expect(effectivePermissions({ id: 'x', adminRole: 'USER' }, LEGACY)).toEqual([]);
  });
});

describe('étape 7 — permission exigée par route et méthode', () => {
  const cases: Array<[string, string, AdminPermission]> = [
    ['PATCH', '/users/abc/status', 'users.suspend'],
    ['GET', '/users/abc', 'users.view'],
    ['GET', '/dashboard', 'stats.view'],
    ['PATCH', '/videos/abc/status', 'moderation.content.moderate'],
    ['GET', '/reports', 'moderation.reports.view'],
    ['PATCH', '/reports/abc', 'moderation.content.moderate'],
    ['GET', '/transactions', 'finance.transactions.view'],
    ['POST', '/transactions/abc/refund-review', 'finance.refunds.review'],
    ['GET', '/withdrawals', 'finance.withdrawals.view'],
    ['PATCH', '/withdrawals/abc', 'finance.withdrawals.process'],
    ['PATCH', '/fraud/users/abc', 'finance.fraud.manage'],
    ['GET', '/disputes', 'finance.transactions.view'],
    ['POST', '/disputes/abc', 'finance.refunds.review'],
    ['GET', '/coins/gifts', 'finance.coins.view'],
    ['POST', '/coins/users/abc/adjust', 'finance.coins.adjust'],
    ['PATCH', '/coins/gifts/abc', 'finance.gifts.prices.update'],
    ['PATCH', '/coins/packages/abc', 'finance.coins.update'],
    ['POST', '/certification/abc/certify', 'creators.certify'],
    ['GET', '/certification', 'creators.view'],
    ['GET', '/lives', 'moderation.lives.view'],
    ['GET', '/creators', 'creators.view'],
    ['GET', '/audit', 'audit.view'],
    ['GET', '/admins', 'admins.view'],
    ['POST', '/admins', 'admins.create'],
    ['PATCH', '/admins/abc/status', 'admins.deactivate'],
    ['PUT', '/admins/abc/permissions', 'admins.permissions.update'],
    ['PATCH', '/admins/abc/role', 'admins.update'],
    ['GET', '/permissions', 'admins.view'],
    ['GET', '/config', 'config.view'],
    ['PATCH', '/config/abc', 'admin.access'],
    ['GET', '/me', 'admin.access'],
    ['GET', '/unknown-family', 'admin.access'],
  ];
  for (const [method, path, perm] of cases) {
    it(`${method} ${path} → ${perm}`, () => {
      expect(permissionForAdminPath(method, path)).toBe(perm);
    });
  }
});

describe('étape 7 — catégories de configuration', () => {
  it('chaque catégorie financière a sa propre permission', () => {
    expect(configPermissionFor('COMMISSION')).toBe('finance.commissions.update');
    expect(configPermissionFor('PREMIUM')).toBe('finance.premium.prices.update');
    expect(configPermissionFor('WITHDRAWALS')).toBe('finance.withdrawal_settings.update');
    expect(configPermissionFor('FEATURE_PRICING')).toBe('finance.features.prices.update');
    expect(configPermissionFor('GENERAL')).toBe('config.general.update');
  });
});
