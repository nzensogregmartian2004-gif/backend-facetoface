import type { NotificationType, Prisma } from '@prisma/client';
import { publishRealtime } from '../../realtime/realtime';
import { sendPush, type PushPayload } from './push.service';

export type NotifyInput = {
  userId: string;
  type: NotificationType;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  amount?: number;
  currency?: string;
  /**
   * Charge utile de la notification push. Jamais enregistrée en base.
   * La push part dès la création : ne la fournir qu'avec le client Prisma principal (hors transaction),
   * sinon une push pourrait partir pour une notification annulée par un rollback.
   */
  pushPayload?: PushPayload;
};

/** Taille des lots pour `notifyMany` : évite de saturer le pool de connexions avec un grand nombre d'abonnés. */
const NOTIFY_CHUNK = 20;

export async function notify(db: Prisma.TransactionClient | any, input: NotifyInput) {
  const { pushPayload, ...row } = input;

  if (row.type === 'NEW_MESSAGE' && row.targetId) {
    const existing = await db.notification.findFirst({
      where: { userId: row.userId, type: row.type, targetType: row.targetType ?? null, targetId: row.targetId, readAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const updated = await db.notification.update({
        where: { id: existing.id },
        data: { count: { increment: 1 }, actorId: row.actorId ?? existing.actorId, amount: row.amount ?? existing.amount, currency: row.currency ?? existing.currency },
      });
      publishRealtime(row.userId, { type: 'NOTIFICATION', payload: { id: updated.id, ...row, count: updated.count, createdAt: updated.createdAt } });
      return updated;
    }
  }

  const created = await db.notification.create({ data: row });
  publishRealtime(row.userId, { type: 'NOTIFICATION', payload: { id: created.id, ...row, count: created.count, createdAt: created.createdAt } });

  if (pushPayload) {
    sendPush(row.userId, { type: row.type, payload: pushPayload, actorId: row.actorId }).catch((err) => {
      console.error('[push] envoi impossible', err);
    });
  }
  return created;
}

/** Notifie plusieurs destinataires avec le même contenu (ex. nouveau Live pour les abonnés). Renvoie le nombre de destinataires. */
export async function notifyMany(db: Prisma.TransactionClient | any, userIds: string[], input: Omit<NotifyInput, 'userId'>) {
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += NOTIFY_CHUNK) {
    await Promise.all(unique.slice(i, i + NOTIFY_CHUNK).map((userId) => notify(db, { ...input, userId })));
  }
  return unique.length;
}

export async function markTargetRead(db: Prisma.TransactionClient | any, userId: string, type: NotificationType, targetId: string) {
  return db.notification.updateMany({ where: { userId, type, targetId, readAt: null }, data: { readAt: new Date() } });
}
