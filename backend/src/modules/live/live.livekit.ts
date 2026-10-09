import { env } from '../../config/env';
import { signLivekitToken } from '../../utils/callProvider';
import { liveRoomName } from './live.video.grants';

export const liveVideoConfigured = () => !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);

const apiBase = () => env.LIVEKIT_URL!.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
const adminToken = (room: string) => signLivekitToken({
  apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET!, identity: 'face-to-face-api', ttlSeconds: 60, video: { roomAdmin: true, roomCreate: true, room },
});

/** Appel d'administration LiveKit (Twirp). Renvoie false si le participant n'est pas connecté (404), vrai sinon. Lève une erreur en cas d'échec. */
async function admin(method: string, room: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${apiBase()}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken(room)}` },
    body: JSON.stringify({ room, ...body }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`LiveKit ${method} : ${res.status}`);
  return true;
}

/** Droit de publier d'un participant connecté : la publication est retirée côté serveur vidéo, pas seulement dans l'application. */
export function setPublishPermission(liveId: string, identity: string, canPublish: boolean): Promise<boolean> {
  return admin('UpdateParticipant', liveRoomName(liveId), { identity, permission: { canSubscribe: true, canPublish, canPublishData: canPublish } });
}

/** Expulse un participant de la salle (blocage). */
export function removeFromRoom(liveId: string, identity: string): Promise<boolean> {
  return admin('RemoveParticipant', liveRoomName(liveId), { identity });
}

/** Ferme la salle à la fin du Live : tous les spectateurs sont coupés proprement. Best effort : une erreur est journalisée. */
export async function closeLiveRoom(liveId: string): Promise<void> {
  if (!liveVideoConfigured()) return;
  try { await admin('DeleteRoom', liveRoomName(liveId), {}); } catch (e) { console.error(`[live] fermeture de la salle vidéo ${liveId} impossible`, e); }
}
