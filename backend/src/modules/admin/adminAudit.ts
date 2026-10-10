import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';

/** Valeur sérialisable pour les champs JSON du journal (les dates deviennent des chaînes). */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Sous-ensemble d'un objet, pour journaliser uniquement les champs modifiés. */
export function pickFields(source: object, keys: readonly string[]): Record<string, unknown> {
  const row = source as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

/**
 * Journalise une modification faite par un administrateur hors /api/admin (Premium, publicité) :
 * ancienne valeur, nouvelle valeur et motif obligatoire, comme le journal d'administration.
 */
export async function recordAdminChange(input: {
  adminId: string; action: string; targetType: string; targetId: string; reason?: string | null; module: string;
  oldValue?: unknown; newValue?: unknown;
}): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      adminId: input.adminId, action: input.action, targetType: input.targetType, targetId: input.targetId,
      reason: input.reason ?? null, module: input.module, result: 'SUCCESS',
      oldValue: toJson(input.oldValue), newValue: toJson(input.newValue),
    },
  });
}
