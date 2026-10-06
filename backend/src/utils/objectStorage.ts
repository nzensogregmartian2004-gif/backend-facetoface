import { env } from '../config/env';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors';
import { signHeaders, presignUrl, uriEncode, type S3Creds } from './s3sign';

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
}

/** Pilote mémoire : pour les tests uniquement (les « envois » sont simulés avec `put`). */
export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, ObjectInfo>();
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
