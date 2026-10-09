import { prisma } from '../../config/db';

export type PushPayload = {
  type: string;
  url?: string;
  conversationId?: string;
  liveId?: string;
  username?: string;
  callId?: string;
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function titleFor(type: string) {
  switch (type) {
    case 'CALL_INCOMING': return 'Face to Face — Appel entrant';
    case 'LIVE_STARTED': return 'Face to Face — Live';
    case 'NEW_MESSAGE': return 'Face to Face — Nouveau message';
    case 'FOLLOW': return 'Face to Face — Nouveau follower';
    default: return 'Face to Face';
  }
}

function bodyFor(type: string, actorName?: string) {
  const actor = actorName ? `${actorName} : ` : '';
  switch (type) {
    case 'CALL_INCOMING': return 'Vous avez un appel entrant.';
    case 'LIVE_STARTED': return `${actor}est en direct.`;
    case 'NEW_MESSAGE': return `${actor}vous a envoyé un message.`;
    case 'FOLLOW': return `${actor}vous suit maintenant.`;
    case 'MESSAGE_PURCHASED': return `${actor}a acheté votre message payant.`;
    case 'GIFT_RECEIVED': return `${actor}vous a envoyé un cadeau.`;
    case 'TIP_RECEIVED': return `${actor}vous a envoyé un tip.`;
    default: return 'Vous avez une nouvelle notification.';
  }
}

export async function sendPush(userId: string, input: { type: string; payload: PushPayload; actorId?: string }) {
  if (process.env.NODE_ENV === 'test') return;
  const devices = await prisma.pushDevice.findMany({
    where: { userId, active: true },
    select: { id: true, token: true },
  });
  if (!devices.length) return;

  let actorName: string | undefined;
  if (input.actorId) {
    const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { displayName: true } });
    actorName = actor?.displayName;
  }

  const isCall = input.type === 'CALL_INCOMING';
  const messages = devices.map((device) => ({
    to: device.token,
    title: titleFor(input.type),
    body: bodyFor(input.type, actorName),
    data: input.payload,
    sound: 'default',
    priority: isCall ? 'high' : 'default',
    ...(isCall ? { channelId: 'calls' } : {}),
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!response.ok) throw new Error(`Expo Push HTTP ${response.status}`);
    const result = await response.json() as { data?: Array<{ status?: string; details?: { error?: string } }> };
    const invalidIds = result.data
      ?.map((item, i) => item.details?.error === 'DeviceNotRegistered' ? devices[i]?.id : null)
      .filter((id): id is string => !!id) ?? [];
    if (invalidIds.length) await prisma.pushDevice.updateMany({ where: { id: { in: invalidIds } }, data: { active: false } });
  } catch (error) {
    console.error('[push] envoi Expo échoué:', error);
  }
}
