import { prisma } from '../../config/db';
import type { AdminCandidate } from './permissions';
import { roleFor } from './roles';

/**
 * Charge à chaque requête authentifiée les permissions accordées au compte.
 * Ainsi une révocation prend effet à la requête suivante, sans cache ni reconnexion.
 */
export async function attachAdminContext(user: AdminCandidate & { id: string }): Promise<void> {
  if (roleFor(user) === 'USER') { user.adminPermissions = []; return; }
  const grants = await prisma.adminPermissionGrant.findMany({ where: { userId: user.id }, select: { permission: true } });
  user.adminPermissions = grants.map((g) => g.permission);
}
