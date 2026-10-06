import crypto from 'node:crypto';

/**
 * Signature AWS SigV4 minimale (compatible S3, Cloudflare R2, MinIO…) sans dépendance externe.
 * Sert à (1) fabriquer des URL pré-signées (upload direct du mobile vers le stockage objet, lecture, téléchargement)
 * et (2) signer les requêtes serveur HEAD/DELETE. Validé par les exemples officiels de la documentation S3 (tests/units.test.ts).
 */
export type S3Creds = { accessKey: string; secretKey: string; region: string; service?: string };

const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();
export const sha256hex = (d: string | Buffer) => crypto.createHash('sha256').update(d).digest('hex');
export const EMPTY_SHA256 = sha256hex('');

/** Encodage URI de SigV4 (RFC 3986 strict). */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = (p: string) => p.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/';

function signingKey(c: S3Creds, date: string) {
  const kDate = hmac('AWS4' + c.secretKey, date);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, c.service ?? 's3');
  return hmac(kService, 'aws4_request');
}
const stamp = (now: Date) => now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z

function canonicalQuery(params: [string, string][]) {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaders(h: Record<string, string>) {
  const entries = Object.entries(h).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { text: entries.map(([k, v]) => `${k}:${v}\n`).join(''), list: entries.map(([k]) => k).join(';') };
}

/** URL pré-signée (authentification par paramètres d'URL). Les en-têtes de `headers` sont signés : le client doit les renvoyer à l'identique. */
export function presignUrl(o: { method: string; url: string; creds: S3Creds; expiresSeconds: number; headers?: Record<string, string>; query?: Record<string, string>; now?: Date }): string {
  const now = o.now ?? new Date();
  const u = new URL(o.url);
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${o.creds.region}/${o.creds.service ?? 's3'}/aws4_request`;
  const ch = canonicalHeaders({ host: u.host, ...(o.headers ?? {}) });
  const params: [string, string][] = [...u.searchParams.entries(), ...Object.entries(o.query ?? {})];
  params.push(['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${o.creds.accessKey}/${scope}`], ['X-Amz-Date', amzDate], ['X-Amz-Expires', String(o.expiresSeconds)], ['X-Amz-SignedHeaders', ch.list]);
  const cq = canonicalQuery(params);
  const canonical = [o.method.toUpperCase(), encodePath(u.pathname), cq, ch.text, ch.list, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(o.creds, date)).update(toSign).digest('hex');
  return `${u.origin}${u.pathname}?${cq}&X-Amz-Signature=${signature}`;
}

/** En-têtes signés pour une requête serveur (HEAD, DELETE…) — authentification par en-tête Authorization. */
export function signHeaders(o: { method: string; url: string; creds: S3Creds; headers?: Record<string, string>; payloadHash?: string; now?: Date }): Record<string, string> {
  const now = o.now ?? new Date();
  const u = new URL(o.url);
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${o.creds.region}/${o.creds.service ?? 's3'}/aws4_request`;
  const payloadHash = o.payloadHash ?? EMPTY_SHA256;
  const all = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(o.headers ?? {}) };
  const ch = canonicalHeaders(all);
  const cq = canonicalQuery([...u.searchParams.entries()]);
  const canonical = [o.method.toUpperCase(), encodePath(u.pathname), cq, ch.text, ch.list, payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(o.creds, date)).update(toSign).digest('hex');
  const { host: _host, ...sendable } = all; // `host` est posé par fetch lui-même
  return { ...sendable, Authorization: `AWS4-HMAC-SHA256 Credential=${o.creds.accessKey}/${scope},SignedHeaders=${ch.list},Signature=${signature}` };
}
