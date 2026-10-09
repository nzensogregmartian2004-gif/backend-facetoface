/**
 * Permissions d'administration. Une permission = une action précise, attribuable individuellement.
 * Le super administrateur possède toutes les permissions ; un administrateur n'a que celles qui lui sont accordées.
 * Fonctions pures : aucun accès à la base ni à l'environnement, donc testables directement.
 */
export const CATALOG = [
  { key: 'users.view', family: 'users', label: 'Voir les utilisateurs' },
  { key: 'users.edit', family: 'users', label: 'Modifier un utilisateur' },
  { key: 'users.suspend', family: 'users', label: 'Suspendre un utilisateur' },
  { key: 'users.reactivate', family: 'users', label: 'Réactiver un utilisateur' },
  { key: 'moderation.reports.view', family: 'moderation', label: 'Voir les signalements' },
  { key: 'moderation.content.moderate', family: 'moderation', label: 'Modérer les contenus' },
  { key: 'moderation.content.delete', family: 'moderation', label: 'Supprimer un contenu' },
  { key: 'moderation.lives.view', family: 'moderation', label: 'Voir les Lives' },
  { key: 'support.tickets.view', family: 'support', label: 'Consulter les tickets' },
  { key: 'support.tickets.reply', family: 'support', label: 'Répondre aux utilisateurs' },
  { key: 'support.tickets.status', family: 'support', label: 'Modifier le statut d’un ticket' },
  { key: 'creators.view', family: 'creators', label: 'Voir les créateurs' },
  { key: 'creators.certify', family: 'creators', label: 'Certifier et révoquer un compte' },
  { key: 'creators.eligibility.review', family: 'creators', label: 'Valider l’éligibilité des créateurs' },
  { key: 'finance.transactions.view', family: 'finance', label: 'Voir les transactions' },
  { key: 'finance.revenue.view', family: 'finance', label: 'Voir les revenus' },
  { key: 'finance.withdrawals.view', family: 'finance', label: 'Voir les retraits' },
  { key: 'finance.balances.view', family: 'finance', label: 'Voir les soldes' },
  { key: 'finance.refunds.review', family: 'finance', label: 'Effectuer un remboursement' },
  { key: 'finance.payments.manage', family: 'finance', label: 'Gérer les paiements' },
  { key: 'finance.withdrawals.process', family: 'finance', label: 'Traiter les retraits' },
  { key: 'finance.fraud.manage', family: 'finance', label: 'Gérer les alertes de fraude' },
  { key: 'finance.coins.view', family: 'finance', label: 'Voir les coins et cadeaux' },
  { key: 'finance.coins.update', family: 'finance', label: 'Modifier les prix des coins' },
  { key: 'finance.coins.adjust', family: 'finance', label: 'Ajuster le solde de coins' },
  { key: 'finance.gifts.prices.update', family: 'finance', label: 'Modifier les prix des cadeaux' },
  { key: 'finance.commissions.update', family: 'finance', label: 'Modifier les commissions' },
  { key: 'finance.premium.prices.update', family: 'finance', label: 'Modifier les prix Premium' },
  { key: 'finance.features.prices.update', family: 'finance', label: 'Modifier les tarifs des appels et contenus payants' },
  { key: 'finance.creator_rules.update', family: 'finance', label: 'Modifier les règles de rémunération des créateurs' },
  { key: 'finance.withdrawal_settings.update', family: 'finance', label: 'Modifier les paramètres de retrait' },
  { key: 'premium.subscriptions.manage', family: 'premium', label: 'Gérer les abonnements Premium' },
  { key: 'advertising.manage', family: 'advertising', label: 'Gérer la publicité' },
  { key: 'stats.view', family: 'stats', label: 'Voir les statistiques' },
  { key: 'admins.view', family: 'admins', label: 'Voir les administrateurs' },
  { key: 'admins.create', family: 'admins', label: 'Créer un administrateur' },
  { key: 'admins.update', family: 'admins', label: 'Modifier un administrateur' },
  { key: 'admins.deactivate', family: 'admins', label: 'Suspendre ou désactiver un administrateur' },
  { key: 'admins.permissions.update', family: 'admins', label: 'Modifier les permissions' },
  { key: 'audit.view', family: 'audit', label: 'Consulter le journal d’audit' },
  { key: 'config.view', family: 'config', label: 'Voir la configuration' },
  { key: 'config.general.update', family: 'config', label: 'Modifier la configuration générale' },
] as const;

export type CatalogKey = (typeof CATALOG)[number]['key'];
/** Permission d'entrée dans l'administration : accordée à tout administrateur actif, sans attribution. */
export type AdminPermission = CatalogKey | 'admin.access';

export const ALL_KEYS: readonly CatalogKey[] = CATALOG.map((c) => c.key);
export const isCatalogKey = (k: string): k is CatalogKey => (ALL_KEYS as readonly string[]).includes(k);
export const familyOf = (p: string): string => p.split('.')[0];

export const FAMILIES: Record<string, string> = {
  users: 'Utilisateurs', moderation: 'Modération', support: 'Support', creators: 'Créateurs', finance: 'Finance',
  premium: 'Premium', advertising: 'Publicité', stats: 'Statistiques', admins: 'Administration', audit: 'Audit', config: 'Configuration',
};

export const ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
export type AdminStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

/** Ce qu'il faut savoir d'un compte pour décider de ses droits. */
export type AdminCandidate = {
  id: string;
  adminRole?: Role | null;
  adminStatus?: AdminStatus | null;
  mustChangePassword?: boolean;
  /** Permissions accordées, chargées à chaque requête authentifiée. */
  adminPermissions?: string[];
};
export type LegacyLists = { superAdmins: readonly string[]; admins: readonly string[] };

/** Rôle effectif. Un rôle explicite (USER compris) l'emporte toujours sur l'environnement. */
export function roleFor(u: AdminCandidate, legacy: LegacyLists): Role {
  if (u.adminRole) return u.adminRole;
  if (legacy.superAdmins.includes(u.id)) return 'SUPER_ADMIN';
  return 'USER';
}

/** Décision centrale : un compte peut-il exercer cette permission ? */
export function canAct(u: AdminCandidate, p: AdminPermission, legacy: LegacyLists): boolean {
  const role = roleFor(u, legacy);
  if (role === 'USER') return false;
  if (u.adminStatus && u.adminStatus !== 'ACTIVE') return false;
  if (p === 'admin.access') return true;
  if (role === 'SUPER_ADMIN') return true;
  return (u.adminPermissions ?? []).includes(p);
}

/** Permissions effectives d'un compte, pour l'interface. */
export function effectivePermissions(u: AdminCandidate, legacy: LegacyLists): AdminPermission[] {
  const role = roleFor(u, legacy);
  if (role === 'USER' || (u.adminStatus && u.adminStatus !== 'ACTIVE')) return [];
  if (role === 'SUPER_ADMIN') return ['admin.access', ...ALL_KEYS];
  return ['admin.access', ...(u.adminPermissions ?? []).filter(isCatalogKey)];
}

/** Modèles préremplis : un raccourci pour attribuer un ensemble cohérent de permissions. */
export const PRESETS: ReadonlyArray<{ id: string; label: string; permissions: readonly CatalogKey[] }> = [
  { id: 'moderator', label: 'Modérateur', permissions: ['users.view', 'moderation.reports.view', 'moderation.content.moderate', 'moderation.lives.view', 'creators.view'] },
  { id: 'finance_read', label: 'Finance (lecture)', permissions: ['finance.transactions.view', 'finance.revenue.view', 'finance.withdrawals.view', 'finance.balances.view', 'finance.coins.view', 'stats.view'] },
  { id: 'finance_ops', label: 'Finance (opérations)', permissions: ['finance.transactions.view', 'finance.revenue.view', 'finance.withdrawals.view', 'finance.balances.view', 'finance.coins.view', 'stats.view', 'finance.refunds.review', 'finance.withdrawals.process', 'finance.payments.manage'] },
  { id: 'certification', label: 'Certification', permissions: ['creators.view', 'creators.certify'] },
];

/** Permission exigée par une catégorie de configuration : commissions, prix, retraits, publicité… */
const CONFIG_CATEGORY: Record<string, CatalogKey> = {
  COMMISSION: 'finance.commissions.update',
  FEATURE_PRICING: 'finance.features.prices.update',
  PREMIUM: 'finance.premium.prices.update',
  PROMOTIONS: 'finance.premium.prices.update',
  CREATOR_POOL: 'finance.creator_rules.update',
  MONETIZATION: 'finance.creator_rules.update',
  WITHDRAWALS: 'finance.withdrawal_settings.update',
  ADVERTISING: 'advertising.manage',
};
export function configPermissionFor(category: string): AdminPermission {
  return CONFIG_CATEGORY[category] ?? 'config.general.update';
}

/**
 * Permission exigée par chaque famille de routes /api/admin, selon la méthode.
 * Les lectures et les écritures sont séparées : voir un montant n'autorise pas à le modifier.
 */
export function permissionForAdminPath(method: string, path: string): AdminPermission {
  const m = method.toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  if (m === 'PATCH' && /^\/users\/[^/]+\/status$/.test(path)) return 'users.suspend';
  if (path === '/dashboard') return 'stats.view';
  if (/^\/users(\/|$)/.test(path)) return read ? 'users.view' : 'users.edit';
  if (/^\/(videos|shorts)(\/|$)/.test(path)) return 'moderation.content.moderate';
  if (/^\/reports(\/|$)/.test(path)) return read ? 'moderation.reports.view' : 'moderation.content.moderate';
  if (/^\/fraud(\/|$)/.test(path)) return 'finance.fraud.manage';
  if (/^\/transactions(\/|$)/.test(path)) return read ? 'finance.transactions.view' : 'finance.refunds.review';
  if (/^\/withdrawals(\/|$)/.test(path)) return read ? 'finance.withdrawals.view' : 'finance.withdrawals.process';
  if (/^\/disputes(\/|$)/.test(path)) return read ? 'finance.transactions.view' : 'finance.refunds.review';
  if (/^\/coins(\/|$)/.test(path)) {
    if (read) return 'finance.coins.view';
    if (/\/adjust/.test(path)) return 'finance.coins.adjust';
    if (/\/gifts/.test(path)) return 'finance.gifts.prices.update';
    return 'finance.coins.update';
  }
  if (/^\/certification(\/|$)/.test(path)) return read ? 'creators.view' : 'creators.certify';
  if (/^\/creators(\/|$)/.test(path)) return 'creators.view';
  if (/^\/lives(\/|$)/.test(path)) return 'moderation.lives.view';
  if (/^\/audit(\/|$)/.test(path)) return 'audit.view';
  if (/^\/permissions(\/|$)/.test(path)) return 'admins.view';
  if (/^\/admins(\/|$)/.test(path)) {
    if (read) return 'admins.view';
    if (m === 'POST' && path === '/admins') return 'admins.create';
    if (m === 'PUT' && /\/permissions$/.test(path)) return 'admins.permissions.update';
    if (m === 'PATCH' && /\/status$/.test(path)) return 'admins.deactivate';
    return 'admins.update';
  }
  if (/^\/config(\/|$)/.test(path)) return read ? 'config.view' : 'admin.access';
  return 'admin.access';
}
