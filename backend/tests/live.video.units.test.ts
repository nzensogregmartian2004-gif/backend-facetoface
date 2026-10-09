import { describe, expect, it } from 'vitest';
import { LIVE_COHOST_LIMIT, liveRoomName, participantState, resolveVideoRole, videoGrantFor } from '../src/modules/live/live.video.grants';

const none = null;
const invited = { invitedAt: new Date(), acceptedAt: null, removedAt: null, mutedAt: null, blockedAt: null };
const cohost = { invitedAt: new Date(), acceptedAt: new Date(), removedAt: null, mutedAt: null, blockedAt: null };
const muted = { ...cohost, mutedAt: new Date() };
const removed = { ...cohost, removedAt: new Date() };
const blocked = { invitedAt: null, acceptedAt: null, removedAt: new Date(), mutedAt: null, blockedAt: new Date() };

describe('vidéo du Live : rôle et droit de publier', () => {
  it('l’hôte publie toujours', () => {
    expect(resolveVideoRole(true, none)).toEqual({ allowed: true, role: 'HOST', canPublish: true });
  });
  it('un co-host actif publie, un co-host muet ne publie plus', () => {
    expect(resolveVideoRole(false, cohost)).toEqual({ allowed: true, role: 'COHOST', canPublish: true });
    expect(resolveVideoRole(false, muted)).toEqual({ allowed: true, role: 'COHOST', canPublish: false });
  });
  it('une invitation non acceptée ne donne aucun droit de publier', () => {
    expect(resolveVideoRole(false, invited)).toEqual({ allowed: true, role: 'VIEWER', canPublish: false });
  });
  it('un co-host retiré redevient spectateur', () => {
    expect(resolveVideoRole(false, removed)).toEqual({ allowed: true, role: 'VIEWER', canPublish: false });
  });
  it('un utilisateur bloqué n’obtient aucun jeton, même hôte ou co-host ancien', () => {
    expect(resolveVideoRole(false, blocked)).toEqual({ allowed: false, reason: 'BLOCKED' });
    expect(resolveVideoRole(false, { ...cohost, blockedAt: new Date() })).toEqual({ allowed: false, reason: 'BLOCKED' });
  });
});

describe('vidéo du Live : claims du jeton LiveKit', () => {
  it('un spectateur reçoit sans publier ni envoyer de données', () => {
    expect(videoGrantFor('VIEWER', false, 'live-1')).toEqual({ roomJoin: true, room: 'live-1', canSubscribe: true, canPublish: false, canPublishData: false });
  });
  it('un hôte ou co-host publie et peut envoyer des données', () => {
    expect(videoGrantFor('HOST', true, 'live-1')).toMatchObject({ canPublish: true, canPublishData: true, canSubscribe: true });
  });
  it('la salle est propre au Live et distincte des appels', () => {
    expect(liveRoomName('abc')).toBe('live-abc');
    expect(liveRoomName('abc')).not.toBe(liveRoomName('abd'));
  });
  it('la limite de co-hosts est fixée', () => {
    expect(LIVE_COHOST_LIMIT).toBe(3);
  });
});

describe('vidéo du Live : états des participants', () => {
  it('les états se succèdent : aucun, invité, co-host, retiré, bloqué', () => {
    expect(participantState(none)).toBe('NONE');
    expect(participantState(invited)).toBe('INVITED');
    expect(participantState(cohost)).toBe('COHOST');
    expect(participantState(removed)).toBe('REMOVED');
    expect(participantState(blocked)).toBe('BLOCKED');
  });
});
