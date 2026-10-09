import { env } from '../config/env';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors';
import { signHeaders, presignUrl, uriEncode, sha256hex, type S3Creds } from './s3sign';
import { buildCompleteXml, buildDeleteXml, hasS3Error, parseDeleteErrors, parseListKeys, parseListParts, parseUploadId } from './s3xml';
import { createHash, randomBytes } from 'node:crypto';

export type StoredPart = { partNumber: number; etag: string; size: number };

/**
 * Stockage objet (vidéos, miniatures). Les octets ne transitent JAMAIS par l'API : le mobile envoie directement
 * au stockage via une URL pré-signée ; l'API ne manipule que des clés, des URL et des métadonnées.
 * ÉTAPE 3 : interface + pilote S3-compatible (AWS S3, Cloudflare R2, MinIO…) + pilote mémoire (tests).
 * ÉTAPE 21 : transcodage, qualités multiples, CDN complet, suppression différée — derrière cette même interface.
 */
export type PresignedUpload = { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
export type ObjectInfo = { size: number; contentType: string | null };

export interface ObjectStorage {
  presignUpload(key: string, contentType: string, ttlSeconds: number): PresignedUpload;
  /** Métadonnées de l'objet, ou null s'il n'existe pas. */
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** URL de lecture (CDN si configuré, sinon URL pré-signée). Chaîne vide si le stockage n'est pas configuré. */
  readUrl(key: string, ttlSeconds?: number): string;
  /**
   * URL de lecture TOUJOURS signée et de courte durée, même si un CDN public est configuré. Pour les médias privés (messagerie,
   * messages payants) : une URL de CDN publique serait permanente et partageable, ce qui contournerait le paiement.
   */
  privateReadUrl(key: string, ttlSeconds?: number): string;
  /** URL de téléchargement forcé (Content-Disposition: attachment), toujours signée. */
  downloadUrl(key: string, filename: string, ttlSeconds?: number): string;
  downloadToFile(key: string, destination: string): Promise<void>;
  uploadFile(key: string, source: string, contentType: string): Promise<void>;
  /** Clés d'objets commençant par `prefix` (toutes les pages). */
  listKeys(prefix: string): Promise<string[]>;
  /** Supprime tous les objets commençant par `prefix`. Une erreur de stockage est remontée, jamais avalée. Renvoie le nombre supprimé. */
  deletePrefix(prefix: string): Promise<number>;
  /** Ouvre un envoi par parties ; renvoie l'identifiant de l'envoi. */
  createMultipart(key: string, contentType: string): Promise<string>;
  /** URL pré-signée (PUT) pour envoyer la partie `partNumber`. */
  presignPart(key: string, uploadId: string, partNumber: number, ttlSeconds: number): string;
  /** Parties déjà reçues par le stockage (toutes les pages). */
  listParts(key: string, uploadId: string): Promise<StoredPart[]>;
  /** Assemble les parties en un seul objet. */
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  /** Annule l'envoi et libère les parties reçues. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

const notConfigured = () => new AppError(503, 'STORAGE_NOT_CONFIGURED', "Le stockage des vidéos n'est pas configuré sur ce serveur");
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'video';

export class S3Storage implements ObjectStorage {
  constructor(private cfg: { endpoint?: string; region: string; bucket: string; accessKey: string; secretKey: string; pathStyle: boolean; cdnUrl?: string }) {}

  private get creds(): S3Creds { return { accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey, region: this.cfg.region }; }

  private urlFor(key: string): string {
    const u = new URL(this.cfg.endpoint ?? `https://s3.${this.cfg.region}.amazonaws.com`);
    const path = key.split('/').map(uriEncode).join('/');
    if (this.cfg.pathStyle) return `${u.origin}/${uriEncode(this.cfg.bucket)}/${path}`;
    return `${u.protocol}//${this.cfg.bucket}.${u.host}/${path}`;
  }

  presignUpload(key: string, contentType: string, ttl: number): PresignedUpload {
    const url = presignUrl({ method: 'PUT', url: this.urlFor(key), creds: this.creds, expiresSeconds: ttl, headers: { 'content-type': contentType } });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const url = this.urlFor(key);
    const res = await fetch(url, { method: 'HEAD', headers: signHeaders({ method: 'HEAD', url, creds: this.creds }) });
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError(502, 'STORAGE_ERROR', 'Le stockage a répondu par une erreur');
    return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') };
  }

  async delete(key: string): Promise<void> {
    const url = this.urlFor(key);
    const res = await fetch(url, { method: 'DELETE', headers: signHeaders({ method: 'DELETE', url, creds: this.creds }) });
    if (!res.ok && res.status !== 404) throw new AppError(502, 'STORAGE_ERROR', 'Le stockage a répondu par une erreur');
  }

  readUrl(key: string, ttl = env.PLAYBACK_URL_TTL_SECONDS): string {
    if (this.cfg.cdnUrl) return `${this.cfg.cdnUrl.replace(/\/$/, '')}/${key.split('/').map(uriEncode).join('/')}`;
    return presignUrl({ method: 'GET', url: this.urlFor(key), creds: this.creds, expiresSeconds: ttl });
  }

  privateReadUrl(key: string, ttl = env.PRIVATE_MEDIA_URL_TTL_SECONDS): string {
    return presignUrl({ method: 'GET', url: this.urlFor(key), creds: this.creds, expiresSeconds: ttl });
  }

  downloadUrl(key: string, filename: string, ttl = env.PLAYBACK_URL_TTL_SECONDS): string {
    return presignUrl({ method: 'GET', url: this.urlFor(key), creds: this.creds, expiresSeconds: ttl, query: { 'response-content-disposition': `attachment; filename="${safeName(filename)}"` } });
  }
  async downloadToFile(key: string, destination: string): Promise<void> {
    const url = presignUrl({ method: 'GET', url: this.urlFor(key), creds: this.creds, expiresSeconds: 900 });
    const res = await fetch(url);
    if (!res.ok) throw new AppError(502, 'STORAGE_ERROR', 'Impossible de lire la vidéo source');
    if (!res.body) throw new AppError(502, 'STORAGE_ERROR', 'Le stockage a renvoyé une réponse sans contenu');
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destination));
  }

  private get bucketBase(): string {
    const u = new URL(this.cfg.endpoint ?? `https://s3.${this.cfg.region}.amazonaws.com`);
    return this.cfg.pathStyle ? `${u.origin}/${uriEncode(this.cfg.bucket)}` : `${u.protocol}//${this.cfg.bucket}.${u.host}`;
  }

  /** Requête signée côté serveur (en-têtes SigV4). Le corps est haché pour la signature. */
  private signedFetch(method: string, url: string, body = '', headers: Record<string, string> = {}): Promise<Response> {
    const sent = signHeaders({ method, url, creds: this.creds, headers, payloadHash: sha256hex(body) });
    return fetch(url, { method, headers: sent, body: body || undefined });
  }

  private async readOk(res: Response, what: string): Promise<string> {
    const text = await res.text();
    if (!res.ok) throw new AppError(502, 'STORAGE_ERROR', `Le stockage a refusé l'opération (${what}, ${res.status})`);
    return text;
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const u = new URL(this.bucketBase + '/');
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', prefix);
      if (token) u.searchParams.set('continuation-token', token);
      const page = parseListKeys(await this.readOk(await this.signedFetch('GET', u.toString()), 'liste'));
      keys.push(...page.keys);
      token = page.truncated ? page.nextToken : null;
    } while (token);
    return keys;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const body = buildDeleteXml(keys.slice(i, i + 1000));
      const u = new URL(this.bucketBase + '/');
      u.searchParams.set('delete', '');
      const headers = { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') };
      const xml = await this.readOk(await this.signedFetch('POST', u.toString(), body, headers), 'suppression');
      if (parseDeleteErrors(xml).length) throw new AppError(502, 'STORAGE_ERROR', 'Suppression incomplète sur le stockage');
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.listKeys(prefix);
    await this.deleteKeys(keys);
    return keys.length;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const u = new URL(this.urlFor(key));
    u.searchParams.set('uploads', '');
    const xml = await this.readOk(await this.signedFetch('POST', u.toString(), '', { 'content-type': contentType }), 'ouverture d\'envoi');
    return parseUploadId(xml);
  }

  presignPart(key: string, uploadId: string, partNumber: number, ttlSeconds: number): string {
    return presignUrl({ method: 'PUT', url: this.urlFor(key), creds: this.creds, expiresSeconds: ttlSeconds, query: { partNumber: String(partNumber), uploadId } });
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | null = null;
    do {
      const u = new URL(this.urlFor(key));
      u.searchParams.set('uploadId', uploadId);
      if (marker) u.searchParams.set('part-number-marker', marker);
      const page = parseListParts(await this.readOk(await this.signedFetch('GET', u.toString()), 'liste des parties'));
      parts.push(...page.parts);
      marker = page.truncated ? page.nextMarker : null;
    } while (marker);
    return parts;
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const u = new URL(this.urlFor(key));
    u.searchParams.set('uploadId', uploadId);
    const xml = await this.readOk(await this.signedFetch('POST', u.toString(), buildCompleteXml(parts), { 'content-type': 'application/xml' }), 'finalisation');
    if (hasS3Error(xml)) throw new AppError(502, 'STORAGE_ERROR', 'Le stockage n\'a pas pu assembler la vidéo');
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const u = new URL(this.urlFor(key));
    u.searchParams.set('uploadId', uploadId);
    const res = await this.signedFetch('DELETE', u.toString());
    await res.text().catch(() => undefined);
    if (!res.ok && res.status !== 404) throw new AppError(502, 'STORAGE_ERROR', 'Annulation d\'envoi refusée par le stockage');
  }

  async uploadFile(key: string, source: string, contentType: string): Promise<void> {
    const url = presignUrl({ method: 'PUT', url: this.urlFor(key), creds: this.creds, expiresSeconds: 900, headers: { 'content-type': contentType } });
    const stream = createReadStream(source);
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: stream as any, duplex: 'half' } as any);
    if (!res.ok) throw new AppError(502, 'STORAGE_ERROR', 'Impossible de publier la vidéo transcodée');
  }
}

/** Stockage non configuré : le serveur démarre (auth, profils…), mais tout envoi de vidéo répond 503. */
export class UnconfiguredStorage implements ObjectStorage {
  presignUpload(): PresignedUpload { throw notConfigured(); }
  async head(): Promise<ObjectInfo | null> { throw notConfigured(); }
  async delete(): Promise<void> { throw notConfigured(); }
  readUrl(): string { return ''; }
  privateReadUrl(): string { return ''; }
  downloadUrl(): string { throw notConfigured(); }
  async downloadToFile(): Promise<void> { throw notConfigured(); }
  async uploadFile(): Promise<void> { throw notConfigured(); }
  async listKeys(): Promise<string[]> { throw notConfigured(); }
  async deletePrefix(): Promise<number> { throw notConfigured(); }
  async createMultipart(): Promise<string> { throw notConfigured(); }
  presignPart(): string { throw notConfigured(); }
  async listParts(): Promise<StoredPart[]> { throw notConfigured(); }
  async completeMultipart(): Promise<void> { throw notConfigured(); }
  async abortMultipart(): Promise<void> { throw notConfigured(); }
}

/** Pilote mémoire : pour les tests uniquement (les « envois » sont simulés avec `put`). */
export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, ObjectInfo>();
  uploads = new Map<string, { key: string; contentType: string; parts: Map<number, { size: number; etag: string }> }>();
  /** Test : simule la réception d'une partie. */
  addPart(uploadId: string, partNumber: number, size: number) {
    const u = this.uploads.get(uploadId);
    if (!u) throw new Error('envoi inconnu');
    u.parts.set(partNumber, { size, etag: `"etag-${partNumber}"` });
  }
  put(key: string, size: number, contentType: string | null) { this.objects.set(key, { size, contentType }); }
  clear() { this.objects.clear(); }
  presignUpload(key: string, contentType: string, ttl: number): PresignedUpload {
    return { url: `memory://upload/${key}`, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
  async head(key: string) { return this.objects.get(key) ?? null; }
  async delete(key: string) { this.objects.delete(key); }
  readUrl(key: string) { return `memory://read/${key}`; }
  privateReadUrl(key: string) { return `memory://private/${key}`; }
  downloadUrl(key: string, filename: string) { return `memory://download/${key}?filename=${encodeURIComponent(filename)}`; }
  async downloadToFile(key: string, destination: string) { const o = this.objects.get(key); if (!o) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Objet introuvable'); await fs.writeFile(destination, Buffer.alloc(Math.min(o.size, 1024), 0)); }
  async uploadFile(key: string, source: string, contentType: string) { const st = await fs.stat(source); this.objects.set(key, { size: st.size, contentType }); }
  async listKeys(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
  async deletePrefix(prefix: string) { const keys = await this.listKeys(prefix); for (const k of keys) this.objects.delete(k); return keys.length; }
  async createMultipart(key: string, contentType: string) { const id = randomBytes(8).toString('hex'); this.uploads.set(id, { key, contentType, parts: new Map() }); return id; }
  presignPart(_key: string, uploadId: string, partNumber: number) { return `memory://part/${uploadId}/${partNumber}`; }
  async listParts(_key: string, uploadId: string): Promise<StoredPart[]> {
    const u = this.uploads.get(uploadId);
    if (!u) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Envoi introuvable');
    return [...u.parts].map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.size })).sort((a, b) => a.partNumber - b.partNumber);
  }
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    const u = this.uploads.get(uploadId);
    if (!u) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Envoi introuvable');
    for (const p of parts) if (!u.parts.has(p.partNumber)) throw new AppError(400, 'STORAGE_PART_MISSING', 'Partie absente');
    const size = [...u.parts.values()].reduce((n, p) => n + p.size, 0);
    this.objects.set(key, { size, contentType: u.contentType });
    this.uploads.delete(uploadId);
  }
  async abortMultipart(_key: string, uploadId: string) { this.uploads.delete(uploadId); }
}

function create(): ObjectStorage {
  if (env.STORAGE_DRIVER === 'memory') return new MemoryStorage();
  const { STORAGE_ACCESS_KEY: accessKey, STORAGE_SECRET_KEY: secretKey, STORAGE_BUCKET: bucket } = env;
  if (!accessKey || !secretKey || !bucket) return new UnconfiguredStorage();
  const pathStyle = env.STORAGE_FORCE_PATH_STYLE ? env.STORAGE_FORCE_PATH_STYLE === 'true' : !!env.STORAGE_ENDPOINT;
  return new S3Storage({ endpoint: env.STORAGE_ENDPOINT, region: env.STORAGE_REGION, bucket, accessKey, secretKey, pathStyle, cdnUrl: env.CDN_URL });
}

export const objectStorage: ObjectStorage = create();
export const objectStorageConfigured = env.STORAGE_DRIVER === 'memory' || Boolean(env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY && env.STORAGE_BUCKET);
