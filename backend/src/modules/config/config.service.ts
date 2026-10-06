import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, forbidden, notFound } from '../../utils/errors';
import { isAdmin } from '../admin/admin.service';
import { CONFIG_DEFAULTS } from './config.defaults';

const VERSION_SEQUENCE = 'monetization_setting_version_seq';
const INITIAL_REASON = 'INITIAL_CONFIGURATION';

export function formatRuleVersion(version: number) {
  return `CFG-${String(version).padStart(6, '0')}`;
}

export function assertConfigAdmin(userId: string) {
  if (!isAdmin(userId)) throw forbidden('ADMIN_REQUIRED', 'Admin access required');
}

function normalize(value: unknown, type: string): unknown {
  if (type === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw badRequest('INVALID_CONFIG_VALUE', 'Configuration value must be boolean');
    return value;
  }
  if (type === 'INTEGER') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest('INVALID_CONFIG_VALUE', 'Configuration value must be an integer');
    return value;
  }
  if (type === 'DECIMAL') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('INVALID_CONFIG_VALUE', 'Configuration value must be numeric');
    return value;
  }
  if (type === 'STRING') {
    if (typeof value !== 'string') throw badRequest('INVALID_CONFIG_VALUE', 'Configuration value must be a string');
    return value;
  }
  return value;
}

async function nextVersion(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRawUnsafe<Array<{ version: number }>>(`SELECT nextval('${VERSION_SEQUENCE}')::int AS version`);
  return rows[0].version;
}

async function createVersion(tx: Prisma.TransactionClient, input: {
  version: number;
  settingKey: string;
  oldValue: unknown;
  newValue: unknown;
  adminId?: string;
  reason: string;
  configId?: string;
  viewSettingId?: string;
}) {
  return tx.monetizationSettingVersion.create({
    data: {
      version: input.version,
      settingKey: input.settingKey,
      oldValue: input.oldValue === undefined ? Prisma.JsonNull : input.oldValue as Prisma.InputJsonValue,
      newValue: input.newValue as Prisma.InputJsonValue,
      adminId: input.adminId,
      reason: input.reason,
      configId: input.configId,
      viewSettingId: input.viewSettingId,
    },
  });
}

/** Initialise les valeurs par défaut dans la connexion fournie et crée la version de référence. */
async function ensureDefaultsInDb(db: Prisma.TransactionClient | typeof prisma) {
  for (const item of CONFIG_DEFAULTS) {
    await db.appConfig.upsert({
      where: { key: item.key },
      create: {
        key: item.key,
        value: item.value as Prisma.InputJsonValue,
        type: item.type,
        enabled: true,
        description: item.description,
        defaultValue: item.value as Prisma.InputJsonValue,
        category: item.category,
      },
      update: {},
    });
  }

  await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock(181018)');
  const configs = await db.appConfig.findMany({ orderBy: { key: 'asc' } });
  const legacy = await db.viewMonetizationSetting.findMany({ orderBy: { key: 'asc' } });
  const existingKeys = new Set((await db.monetizationSettingVersion.findMany({ select: { settingKey: true }, distinct: ['settingKey'] })).map(x => x.settingKey));
  const missingConfigs = configs.filter(config => !existingKeys.has(config.key));
  const missingLegacy = legacy.filter(setting => !existingKeys.has(setting.key));
  if (missingConfigs.length || missingLegacy.length) {
    const version = await db.$queryRawUnsafe<Array<{ version: number }>>(`SELECT nextval('${VERSION_SEQUENCE}')::int AS version`);
    const versionNumber = version[0].version;
    for (const config of missingConfigs) {
      await createVersion(db, {
        version: versionNumber,
        settingKey: config.key,
        oldValue: undefined,
        newValue: config.value,
        reason: INITIAL_REASON,
        configId: config.id,
      });
    }
    for (const setting of missingLegacy) {
      await createVersion(db, {
        version: versionNumber,
        settingKey: setting.key,
        oldValue: undefined,
        newValue: setting.value,
        reason: INITIAL_REASON,
        viewSettingId: setting.id,
      });
    }
  }
}

export async function ensureDefaults() {
  return prisma.$transaction(async tx => ensureDefaultsInDb(tx));
}

export async function getCurrentRuleVersion(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string | null> {
  let latest = await db.monetizationSettingVersion.findFirst({ orderBy: [{ version: 'desc' }, { changedAt: 'desc' }], select: { version: true } });
  if (!latest) {
    if (db === prisma) await ensureDefaults();
    else await ensureDefaultsInDb(db);
    latest = await db.monetizationSettingVersion.findFirst({ orderBy: [{ version: 'desc' }, { changedAt: 'desc' }], select: { version: true } });
  }
  return latest ? formatRuleVersion(latest.version) : null;
}

export async function listConfigVersions(userId: string, input: { key?: string; version?: number; limit?: number }) {
  assertConfigAdmin(userId);
  await ensureDefaults();
  return prisma.monetizationSettingVersion.findMany({
    where: {
      settingKey: input.key,
      version: input.version,
    },
    orderBy: [{ version: 'desc' }, { settingKey: 'asc' }],
    take: input.limit ?? 100,
    include: { admin: { select: { id: true, username: true, displayName: true } } },
  });
}

export async function getConfigVersion(userId: string, version: number) {
  assertConfigAdmin(userId);
  await ensureDefaults();
  return prisma.monetizationSettingVersion.findMany({
    where: { version },
    orderBy: { settingKey: 'asc' },
    include: { admin: { select: { id: true, username: true, displayName: true } } },
  });
}

export async function listConfigs(userId: string, filters: { category?: string; enabled?: boolean; q?: string }) {
  assertConfigAdmin(userId);
  await ensureDefaults();
  return prisma.appConfig.findMany({
    where: {
      category: filters.category as any,
      enabled: filters.enabled,
      OR: filters.q ? [{ key: { contains: filters.q, mode: 'insensitive' } }, { description: { contains: filters.q, mode: 'insensitive' } }] : undefined,
    },
    orderBy: [{ category: 'asc' }, { key: 'asc' }],
  });
}

export async function getConfig(userId: string, key: string) {
  assertConfigAdmin(userId);
  await ensureDefaults();
  const item = await prisma.appConfig.findUnique({ where: { key } });
  if (!item) throw notFound('Configuration not found');
  return item;
}

export async function getConfigValue<T = unknown>(key: string, fallback?: T, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<T | undefined> {
  const item = await db.appConfig.findUnique({ where: { key } });
  if (!item || !item.enabled) return fallback;
  return item.value as T;
}

export async function upsertConfig(userId: string, input: {
  key: string; value: unknown; type: string; enabled: boolean; description: string; defaultValue: unknown; category: string; reason: string;
}) {
  assertConfigAdmin(userId);
  if (!input.reason.trim()) throw badRequest('CONFIG_REASON_REQUIRED', 'Une raison est obligatoire pour modifier un paramètre');
  const value = normalize(input.value, input.type);
  const defaultValue = normalize(input.defaultValue, input.type);

  return prisma.$transaction(async tx => {
    const existing = await tx.appConfig.findUnique({ where: { key: input.key } });
    const result = await tx.appConfig.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        value: value as Prisma.InputJsonValue,
        type: input.type as any,
        enabled: input.enabled,
        description: input.description,
        defaultValue: defaultValue as Prisma.InputJsonValue,
        category: input.category as any,
        updatedById: userId,
      },
      update: {
        value: value as Prisma.InputJsonValue,
        type: input.type as any,
        enabled: input.enabled,
        description: input.description,
        defaultValue: defaultValue as Prisma.InputJsonValue,
        category: input.category as any,
        updatedById: userId,
      },
    });
    const version = await nextVersion(tx);
    await createVersion(tx, {
      version,
      settingKey: result.key,
      oldValue: existing?.value,
      newValue: result.value,
      adminId: userId,
      reason: input.reason.trim(),
      configId: result.id,
    });
    await tx.adminAuditLog.create({
      data: {
        adminId: userId,
        action: existing ? 'CONFIG_UPDATE' : 'CONFIG_CREATE',
        targetType: 'APP_CONFIG',
        targetId: result.id,
        reason: input.reason.trim(),
        metadata: { key: result.key, value: result.value, type: result.type, version: formatRuleVersion(version) },
      },
    });
    return result;
  });
}

export async function updateConfig(userId: string, key: string, input: { value: unknown; enabled?: boolean; description?: string; reason: string }) {
  assertConfigAdmin(userId);
  if (!input.reason?.trim()) throw badRequest('CONFIG_REASON_REQUIRED', 'Une raison est obligatoire pour modifier un paramètre');

  return prisma.$transaction(async tx => {
    const existing = await tx.appConfig.findUnique({ where: { key } });
    if (!existing) throw notFound('Configuration not found');
    const value = normalize(input.value, existing.type);
    const updated = await tx.appConfig.update({
      where: { key },
      data: {
        value: value as Prisma.InputJsonValue,
        enabled: input.enabled ?? existing.enabled,
        description: input.description ?? existing.description,
        updatedById: userId,
      },
    });
    const version = await nextVersion(tx);
    await createVersion(tx, {
      version,
      settingKey: updated.key,
      oldValue: existing.value,
      newValue: updated.value,
      adminId: userId,
      reason: input.reason.trim(),
      configId: updated.id,
    });
    await tx.adminAuditLog.create({
      data: {
        adminId: userId,
        action: 'CONFIG_UPDATE',
        targetType: 'APP_CONFIG',
        targetId: updated.id,
        reason: input.reason.trim(),
        metadata: { key: updated.key, oldValue: existing.value, value: updated.value, version: formatRuleVersion(version) },
      },
    });
    return updated;
  });
}

export async function restoreDefaults(userId: string) {
  assertConfigAdmin(userId);
  await ensureDefaults();
  return prisma.$transaction(async tx => {
    const changes: Array<{ key: string; existing: any }> = [];
    for (const item of CONFIG_DEFAULTS) {
      const existing = await tx.appConfig.findUnique({ where: { key: item.key } });
      if (!existing) continue;
      const changed = JSON.stringify(existing.value) !== JSON.stringify(item.value) || !existing.enabled;
      if (changed) changes.push({ key: item.key, existing });
    }
    if (changes.length === 0) return { restored: 0, version: null, auditId: null };
    const version = await nextVersion(tx);
    let restored = 0;
    for (const change of changes) {
      const item = CONFIG_DEFAULTS.find(x => x.key === change.key)!;
      const updated = await tx.appConfig.update({
        where: { key: item.key },
        data: { value: item.value as Prisma.InputJsonValue, enabled: true, updatedById: userId },
      });
      await createVersion(tx, {
        version,
        settingKey: updated.key,
        oldValue: change.existing.value,
        newValue: updated.value,
        adminId: userId,
        reason: 'RESTORE_DEFAULTS',
        configId: updated.id,
      });
      restored++;
    }
    const log = await tx.adminAuditLog.create({
      data: {
        adminId: userId,
        action: 'CONFIG_RESTORE_DEFAULTS',
        targetType: 'APP_CONFIG',
        targetId: 'ALL',
        reason: 'RESTORE_DEFAULTS',
        metadata: { restored, version: formatRuleVersion(version) },
      },
    });
    return { restored, version: formatRuleVersion(version), auditId: log.id };
  });
}
