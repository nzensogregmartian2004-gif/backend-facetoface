import { createHash } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { prisma } from '../config/db';
import { verifyAccessToken } from '../utils/tokens';
import { isAllowedOrigin } from '../middleware/security';
import { RoomRegistry, WindowLimiter } from './rooms';

type Client = { id: number; socket: Socket; userId: string; buffer: Buffer; ip: string; limiter: WindowLimiter };
const MAX_FRAME_BYTES = 64 * 1024;
/** Messages de contrôle (live:join / live:leave) : très petits. Au-delà, ignorés. */
const MAX_CONTROL_BYTES = 1024;
/** Débit par connexion : au plus CONTROL_LIMIT messages de contrôle par fenêtre de CONTROL_WINDOW_MS. */
const CONTROL_LIMIT = 30;
const CONTROL_WINDOW_MS = 10_000;
const MAX_PENDING_PER_IP = 20;
const connectionsByIp = new Map<string, number>();
export type RealtimeEvent = { type: string; payload?: unknown };
type RoomAuthorizer = (userId: string, roomId: string) => Promise<boolean>;

const clients = new Set<Client>();
let nextClientId = 1;
/**
 * Salles de diffusion : une salle par Live. Un seul serveur pour l'instant : au-delà d'une instance,
 * la diffusion devra passer par Redis pub/sub (hors de cette étape).
 */
const rooms = new RoomRegistry<Client>();
let roomAuthorizer: RoomAuthorizer | null = null;
/** Présence : nombre de connexions authentifiées par utilisateur. « En ligne » tant qu'au moins une connexion est ouverte. */
const connectionsByUser = new Map<string, number>();
type PresenceListener = (userId: string, online: boolean) => void;
type TypingHandler = (userId: string, conversationId: string) => Promise<void>;
let presenceListener: PresenceListener | null = null;
let typingHandler: TypingHandler | null = null;
export function setPresenceListener(fn: PresenceListener) { presenceListener = fn; }
export function setTypingHandler(fn: TypingHandler) { typingHandler = fn; }
export function isUserOnline(userId: string) { return (connectionsByUser.get(userId) ?? 0) > 0; }

/** Branché par le module Live (même règle que joinLive). Sans vérificateur, aucune salle ne s'ouvre. */
export function setRoomAuthorizer(fn: RoomAuthorizer) { roomAuthorizer = fn; }

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); return Buffer.concat([h, payload]); }
  const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return Buffer.concat([h, payload]);
}

function close(socket: Socket) { try { socket.end(Buffer.from([0x88, 0x00])); } catch { socket.destroy(); } }

function send(client: Client, event: RealtimeEvent) {
  try { client.socket.write(frame(JSON.stringify(event))); } catch { /* connexion fermée : nettoyée à la fermeture */ }
}

function parseFrames(client: Client) {
  while (client.buffer.length >= 2) {
    const b0 = client.buffer[0], b1 = client.buffer[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let offset = 2;
    let len = b1 & 0x7f;
    if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (client.buffer.length < 10) return; const n = client.buffer.readBigUInt64BE(2); if (n > BigInt(Number.MAX_SAFE_INTEGER)) { close(client.socket); return; } len = Number(n); offset = 10; }
    if (len > MAX_FRAME_BYTES) { close(client.socket); return; }
    if (!masked || client.buffer.length < offset + 4 + len) { if (!masked) close(client.socket); return; }
    const key = client.buffer.subarray(offset, offset + 4); offset += 4;
    const data = Buffer.from(client.buffer.subarray(offset, offset + len)); client.buffer = client.buffer.subarray(offset + len);
    for (let i = 0; i < data.length; i++) data[i] ^= key[i % 4];
    if (opcode === 0x8) { close(client.socket); return; }
    if (opcode === 0x9) {
      if (data.length > 125) { close(client.socket); return; }
      client.socket.write(Buffer.from([0x8a, data.length, ...data]));
      continue;
    }
    if (opcode !== 0x1) continue;
    let message: any; try { message = JSON.parse(data.toString('utf8')); } catch { continue; }
    void handleMessage(client, message, data.length);
  }
}

async function handleMessage(client: Client, message: any, size: number) {
  if (client.userId) { void handleControl(client, message, size); return; }
  if (message?.type !== 'auth' || typeof message.token !== 'string' || message.token.length > 4096) { close(client.socket); return; }
  const claims = verifyAccessToken(message.token);
  if (!claims) { close(client.socket); return; }
  const session = await prisma.session.findUnique({ where: { id: claims.sid }, select: { userId: true, revokedAt: true, expiresAt: true } }).catch(() => null);
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < new Date()) { close(client.socket); return; }
  client.userId = session.userId;
  const count = connectionsByUser.get(client.userId) ?? 0;
  connectionsByUser.set(client.userId, count + 1);
  if (count === 0) presenceListener?.(client.userId, true);
  client.socket.write(frame(JSON.stringify({ type: 'ready', payload: { userId: client.userId } })));
}

/** Contrôle d'une salle après authentification : live:join (admis si la règle d'accès du Live le permet) et live:leave. */
async function handleControl(client: Client, message: any, size: number) {
  if (message?.type === 'typing') { // saisie : silencieusement limitée, jamais de réponse
    if (size > MAX_CONTROL_BYTES || !client.limiter.allow(Date.now())) return;
    const conversationId = typeof message.conversationId === 'string' && message.conversationId.length > 0 && message.conversationId.length <= 64 ? message.conversationId : null;
    if (conversationId && typingHandler) void typingHandler(client.userId, conversationId).catch(() => {});
    return;
  }
  if (message?.type !== 'live:join' && message?.type !== 'live:leave') return;
  if (size > MAX_CONTROL_BYTES) return;
  if (!client.limiter.allow(Date.now())) { send(client, { type: 'error', payload: { code: 'RATE_LIMITED' } }); return; }
  const liveId = typeof message.liveId === 'string' && message.liveId.length > 0 && message.liveId.length <= 64 ? message.liveId : null;
  if (!liveId) return;
  if (message.type === 'live:leave') { rooms.leave(client, liveId); send(client, { type: 'live:left', payload: { liveId } }); return; }
  let allowed = false;
  try { allowed = roomAuthorizer ? await roomAuthorizer(client.userId, liveId) : false; } catch { allowed = false; }
  if (!clients.has(client)) return; // connexion fermée pendant la vérification
  if (!allowed) { send(client, { type: 'live:denied', payload: { liveId } }); return; } // même réponse qu'un Live inexistant
  rooms.join(client, liveId);
  send(client, { type: 'live:joined', payload: { liveId } });
}

export function publishRealtime(userId: string, event: RealtimeEvent) {
  const data = frame(JSON.stringify(event));
  for (const client of clients) {
    if (client.userId !== userId) continue;
    try { client.socket.write(data); } catch { clients.delete(client); client.socket.destroy(); }
  }
}

export function publishRealtimeMany(userIds: string[], event: RealtimeEvent) {
  for (const id of new Set(userIds)) publishRealtime(id, event);
}

/** Diffuse un événement à tous les spectateurs admis dans la salle d'un Live. Ne lève jamais d'erreur. */
export function publishToRoom(roomId: string, event: RealtimeEvent) {
  const data = frame(JSON.stringify(event));
  rooms.publish(roomId, (client) => client.socket.write(data));
}

/** Ferme la salle d'un Live (fin du Live) : les spectateurs sont retirés. */
export function closeRoom(roomId: string) { rooms.close(roomId); }

export function attachRealtime(server: HttpServer) {
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    if (req.url !== '/realtime') { socket.destroy(); return; }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedOrigin(origin)) { socket.destroy(); return; }
    const ip = String(req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const connections = connectionsByIp.get(ip) ?? 0;
    if (connections >= MAX_PENDING_PER_IP) { socket.destroy(); return; }
    connectionsByIp.set(ip, connections + 1);
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      const current = connectionsByIp.get(ip) ?? 0;
      if (current <= 1) connectionsByIp.delete(ip); else connectionsByIp.set(ip, current - 1);
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client: Client = { id: nextClientId++, socket, userId: '', buffer: Buffer.alloc(0), ip, limiter: new WindowLimiter(CONTROL_LIMIT, CONTROL_WINDOW_MS) };
    clients.add(client);
    socket.on('data', (chunk) => { client.buffer = Buffer.concat([client.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); parseFrames(client); });
    let removed = false;
    const remove = () => {
      if (removed) return; // close puis error : une seule fois
      removed = true;
      clients.delete(client);
      rooms.unregister(client);
      if (client.userId) {
        const count = (connectionsByUser.get(client.userId) ?? 1) - 1;
        if (count <= 0) { connectionsByUser.delete(client.userId); presenceListener?.(client.userId, false); } else connectionsByUser.set(client.userId, count);
      }
      const current = connectionsByIp.get(ip) ?? 0;
      if (current <= 1) connectionsByIp.delete(ip); else connectionsByIp.set(ip, current - 1);
    };
    socket.on('close', remove); socket.on('error', remove);
    const timer = setTimeout(() => { if (!client.userId) close(socket); }, 10_000); timer.unref();
  });
}
