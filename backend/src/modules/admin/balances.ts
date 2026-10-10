import { prisma } from '../../config/db';

/** Portefeuilles créateurs, avec recherche par nom et filtre de devise. Lecture seule. */
export async function listCreatorBalances(input: { q?: string; currency?: string; limit: number }) {
  const where = {
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.q ? { user: { OR: [
      { username: { contains: input.q, mode: 'insensitive' as const } },
      { displayName: { contains: input.q, mode: 'insensitive' as const } },
    ] } } : {}),
  };
  return prisma.wallet.findMany({
    where, orderBy: { updatedAt: 'desc' }, take: input.limit,
    select: {
      id: true, currency: true, availableAmount: true, pendingAmount: true, withdrawnAmount: true,
      blockedAmount: true, refundedAmount: true, updatedAt: true,
      user: { select: { id: true, username: true, displayName: true } },
    },
  });
}
