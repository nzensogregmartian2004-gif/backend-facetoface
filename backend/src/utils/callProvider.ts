import { createHmac } from 'node:crypto';
import { env } from '../config/env';

/**
 * Transport audio/vidéo des appels (port). Le serveur ne fait JAMAIS passer de média : il décide qui a le droit de rejoindre
 * une salle (un appel PAYÉ, ACCEPTÉ et en cours) et délivre un jeton d'accès de courte durée. Le mobile se connecte ensuite directement au fournisseur.
 * Pilotes : `none` (503), `memory` (tests), `livekit` (jetons JWT LiveKit signés ici, sans dépendance supplémentaire).
 */
export type CallGrant = { provider: string; url: string | null; room: string; identity: string; token: string; expiresAt: Date };
export type GrantRequest = { room: string; identity: string; displayName: string; video: boolean; ttlSeconds: number };

export interface CallProvider {
  readonly name: string;
  /** Faux = aucun appel ne peut être proposé ni payé sur ce serveur. */
  configured(): boolean;
  grant(req: GrantRequest): CallGrant;
  /** Ferme la salle côté fournisseur (fin de l'appel, durée maximale atteinte). Au mieux : n'échoue jamais. */
  closeRoom(room: string): Promise<void>;
}

class NoCallProvider implements CallProvider {
  readonly name = 'none';
  configured() { return false; }
  grant(): CallGrant { throw new Error('CALL_PROVIDER=none : aucun jeton ne peut être délivré'); }
  async closeRoom() { /* rien à fermer */ }
}

/** Pilote de test : enregistre les jetons délivrés et les salles fermées. */
export class MemoryCallProvider implements CallProvider {
  readonly name = 'memory';
  grants: (CallGrant & { video: boolean; ttlSeconds: number })[] = [];
  closed: string[] = [];
  clear() { this.grants = []; this.closed = []; }
  configured() { return true; }
  grant(req: GrantRequest): CallGrant {
    const g = { provider: 'memory', url: 'memory://calls', room: req.room, identity: req.identity, token: `mem.${req.room}.${req.identity}`, expiresAt: new Date(Date.now() + req.ttlSeconds * 1000), video: req.video, ttlSeconds: req.ttlSeconds };
    this.grants.push(g);
    return g;
  }
  async closeRoom(room: string) { this.closed.push(room); }
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** JWT HS256 (format des jetons d'accès LiveKit : `iss` = clé d'API, `sub` = identité, claim `video` = droits sur la salle). */
export function signLivekitToken(opts: { apiKey: string; apiSecret: string; identity: string; name?: string; ttlSeconds: number; video: Record<string, unknown>; now?: Date }): string {
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: opts.apiKey, sub: opts.identity, ...(opts.name ? { name: opts.name } : {}), nbf: nowSec, exp: nowSec + opts.ttlSeconds, video: opts.video }));
  const sig = createHmac('sha256', opts.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

class LivekitProvider implements CallProvider {
  readonly name = 'livekit';
  configured() { return !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET); }
  grant(req: GrantRequest): CallGrant {
    const token = signLivekitToken({
      apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET!, identity: req.identity, name: req.displayName, ttlSeconds: req.ttlSeconds,
      video: { roomJoin: true, room: req.room, canPublish: true, canSubscribe: true, canPublishData: true },
    });
    return { provider: 'livekit', url: env.LIVEKIT_URL!, room: req.room, identity: req.identity, token, expiresAt: new Date(Date.now() + req.ttlSeconds * 1000) };
  }
  /** Un jeton n'est vérifié qu'à la connexion : seule la fermeture de la salle (API serveur) coupe un appel qui dépasse la durée payée. */
  async closeRoom(room: string) {
    try {
      const base = env.LIVEKIT_URL!.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
      const token = signLivekitToken({ apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET!, identity: 'face-to-face-api', ttlSeconds: 60, video: { roomCreate: true, roomAdmin: true, room } });
      await fetch(`${base}/twirp/livekit.RoomService/DeleteRoom`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ room }), signal: AbortSignal.timeout(5000) });
    } catch (e) { console.error(`[appels] fermeture de la salle ${room} impossible`, e); }
  }
}

function create(): CallProvider {
  if (env.CALL_PROVIDER === 'memory') return new MemoryCallProvider();
  if (env.CALL_PROVIDER === 'livekit') return new LivekitProvider();
  return new NoCallProvider();
}
export const callProvider: CallProvider = create();
