import type { Prisma, NotificationType } from '@prisma/client';
import { publishRealtime } from '../../realtime/realtime';

export async function notify(db: Prisma.TransactionClient | any, input: { userId: string; type: 'NEW_MESSAGE' | 'MESSAGE_PURCHASED' | 'CREATOR_SUBSCRIPTION_PURCHASED' | 'CREATOR_SUBSCRIPTION_CANCELLED' | 'CUSTOM_VIDEO_REQUESTED' | 'CUSTOM_VIDEO_PAYMENT_CONFIRMED' | 'CUSTOM_VIDEO_DELIVERED' | 'CUSTOM_VIDEO_COMPLETED' | 'CUSTOM_VIDEO_DECLINED'; actorId?: string; targetType?: string; targetId?: string; amountFcfa?: number }) {
  if (input.type === 'NEW_MESSAGE' && input.targetId) {
    const existing = await db.notification.findFirst({ where:{ userId:input.userId, type:input.type, targetType:input.targetType ?? null, targetId:input.targetId, readAt:null }, orderBy:{createdAt:'desc'} });
    if (existing) {
      const updated = await db.notification.update({ where:{id:existing.id}, data:{ count:{increment:1}, actorId:input.actorId ?? existing.actorId, amountFcfa:input.amountFcfa ?? existing.amountFcfa } });
      publishRealtime(input.userId, { type: 'NOTIFICATION', payload: { id: updated.id, ...input, count: updated.count, createdAt: updated.createdAt } });
      return updated;
    }
  }
  const created = await db.notification.create({ data: input });
  publishRealtime(input.userId, { type: 'NOTIFICATION', payload: { id: created.id, ...input, count: created.count, createdAt: created.createdAt } });
  return created;
}

export async function markTargetRead(db: Prisma.TransactionClient | any, userId: string, type: NotificationType, targetId: string) {
  return db.notification.updateMany({ where: { userId, type, targetId, readAt: null }, data: { readAt: new Date() } });
}
