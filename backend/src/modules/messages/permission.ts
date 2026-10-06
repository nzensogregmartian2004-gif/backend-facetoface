import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { hasActiveSubscription } from '../subscriptions/subscriptions.service';

export const pairKey = (a: string, b: string) => [a, b].sort().join(':');

export async function messagingPermission(viewer: User, other: User): Promise<{ allowed: boolean; reason: 'INACTIVE'|'BLOCKED'|'NOT_ALLOWED'|null }> {
  if (other.status !== 'ACTIVE') return { allowed: false, reason: 'INACTIVE' };
  const blocked = await prisma.block.findFirst({ where: { OR: [{ blockerId: viewer.id, blockedId: other.id }, { blockerId: other.id, blockedId: viewer.id }] }, select: { id: true } });
  if (blocked) return { allowed: false, reason: 'BLOCKED' };
  if (other.allowMessagesFrom === 'EVERYONE') return { allowed: true, reason: null };
  if (other.allowMessagesFrom === 'FOLLOWERS') {
    const follows = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer.id, followingId: other.id } }, select: { id: true } });
    if (follows) return { allowed: true, reason: null };
  }
  if (other.isCreator && await hasActiveSubscription(viewer.id, other.id)) {
    const plan = await prisma.creatorSubscriptionPlan.findUnique({ where: { creatorId: other.id }, select: { benefits: true, isActive: true } });
    const benefits = (plan?.benefits ?? {}) as { directMessages?: boolean };
    if (plan?.isActive && benefits.directMessages) return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'NOT_ALLOWED' };
}
