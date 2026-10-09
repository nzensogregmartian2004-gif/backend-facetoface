/**
 * Droits vidéo d'un Live. Fonctions pures : la décision (qui publie, qui reçoit) est prise ici, côté serveur, jamais dans l'application.
 * Salle LiveKit : `live-<liveId>`, distincte des salles d'appel.
 */
export const LIVE_COHOST_LIMIT = 3;

export type LiveVideoRole = 'HOST' | 'COHOST' | 'VIEWER';
export type ParticipantLike = { invitedAt: Date | null; acceptedAt: Date | null; removedAt: Date | null; mutedAt: Date | null; blockedAt: Date | null };
export type ParticipantState = 'BLOCKED' | 'REMOVED' | 'COHOST' | 'INVITED' | 'NONE';

export const liveRoomName = (liveId: string) => `live-${liveId}`;

/** État lisible d'un participant : bloqué, retiré, co-host actif, invitation en attente, ou simple spectateur. */
export function participantState(p: ParticipantLike | null | undefined): ParticipantState {
  if (!p) return 'NONE';
  if (p.blockedAt) return 'BLOCKED';
  if (p.removedAt) return 'REMOVED';
  if (p.acceptedAt) return 'COHOST';
  if (p.invitedAt) return 'INVITED';
  return 'NONE';
}

/** Rôle vidéo et droit de publier. Un bloqué n'obtient aucun jeton ; un co-host muet reçoit seulement. */
export function resolveVideoRole(isHost: boolean, p: ParticipantLike | null | undefined):
  { allowed: true; role: LiveVideoRole; canPublish: boolean } | { allowed: false; reason: 'BLOCKED' } {
  if (p?.blockedAt) return { allowed: false, reason: 'BLOCKED' };
  if (isHost) return { allowed: true, role: 'HOST', canPublish: true };
  if (p?.acceptedAt && !p.removedAt) return { allowed: true, role: 'COHOST', canPublish: !p.mutedAt };
  return { allowed: true, role: 'VIEWER', canPublish: false };
}

/** Claims du jeton LiveKit : spectateur = réception seule ; hôte et co-host = publication selon `canPublish`. */
export function videoGrantFor(role: LiveVideoRole, canPublish: boolean, room: string): Record<string, unknown> {
  return { roomJoin: true, room, canSubscribe: true, canPublish, canPublishData: role !== 'VIEWER' };
}
