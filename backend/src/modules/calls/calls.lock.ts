import type { Prisma } from '@prisma/client';

/** Verrou de ligne sur un utilisateur, le temps de la transaction : sérialise les décisions « occupé / libre » qui le concernent. */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}
