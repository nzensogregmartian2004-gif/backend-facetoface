import { createHash } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { prisma } from '../config/db';
import { verifyAccessToken } from '../utils/tokens';
import { isAllowedOrigin } from '../middleware/security';

type Client = { socket: Socket; userId: string; buffer: Buffer; ip: string };
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_PER_IP = 20;
const connectionsByIp = new Map<string, number>();
export type RealtimeEvent = { type: string; payload?: unknown };

const clients = new Set<Client>();

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); return Buffer.concat([h, payload]); }
  const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return Buffer.concat([h, payload]);
}

function close(socket: Socket) { try { socket.end(Buffer.from([0x88, 0x00])); } catch { socket.destroy(); } }

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
    void handleMessage(client, message);
  }
}

async function handleMessage(client: Client, message: any) {
  if (client.userId) { return; }
  if (message?.type !== 'auth' || typeof message.token !== 'string' || message.token.length > 4096) { close(client.socket); return; }
  const claims = verifyAccessToken(message.token);
  if (!claims) { close(client.socket); return; }
  const session = await prisma.session.findUnique({ where: { id: claims.sid }, select: { userId: true, revokedAt: true, expiresAt: true } }).catch(() => null);
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < new Date()) { close(client.socket); return; }
  client.userId = session.userId;
  client.socket.write(frame(JSON.stringify({ type: 'ready', payload: { userId: client.userId } })));
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
    const client: Client = { socket, userId: '', buffer: Buffer.alloc(0), ip };
    clients.add(client);
    socket.on('data', (chunk) => { client.buffer = Buffer.concat([client.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); parseFrames(client); });
    const remove = () => {
      clients.delete(client);
      const current = connectionsByIp.get(ip) ?? 0;
      if (current <= 1) connectionsByIp.delete(ip); else connectionsByIp.set(ip, current - 1);
    };
    socket.on('close', remove); socket.on('error', remove);
    const timer = setTimeout(() => { if (!client.userId) close(socket); }, 10_000); timer.unref();
  });
}
