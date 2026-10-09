import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/utils/objectStorage';

/**
 * Faux stockage S3 local : vérifie la forme des requêtes (méthode, paramètres, en-têtes de signature, corps)
 * et renvoie des réponses XML réalistes. Ne valide PAS la signature elle-même (couverte ailleurs).
 */
type Seen = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let server: http.Server;
let storage: S3Storage;
const uploadParts = new Map<string, { n: number; etag: string }[]>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body });
      const send = (status: number, xml = '') => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(xml); };
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        if (u.searchParams.get('continuation-token') === 'page2') return send(200, '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>videos/a/hls/720/00001.ts</Key></Contents></ListBucketResult>');
        return send(200, '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken><Contents><Key>videos/a/hls/master.m3u8</Key></Contents></ListBucketResult>');
      }
      if (req.method === 'POST' && u.searchParams.has('delete')) return send(200, '<DeleteResult></DeleteResult>');
      if (req.method === 'POST' && u.searchParams.has('uploads')) return send(200, '<InitiateMultipartUploadResult><UploadId>up-42</UploadId></InitiateMultipartUploadResult>');
      if (req.method === 'GET' && u.searchParams.has('uploadId')) {
        if (u.searchParams.get('part-number-marker') === '1') return send(200, '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag><Size>5</Size></Part></ListPartsResult>');
        return send(200, '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>10</Size></Part></ListPartsResult>');
      }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) return send(200, '<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>');
      if (req.method === 'DELETE' && u.searchParams.has('uploadId')) return send(204);
      send(404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  storage = new S3Storage({ endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket: 'f2f', accessKey: 'AK', secretKey: 'SK', pathStyle: true });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('stockage S3 — forme des requêtes (faux serveur local)', () => {
  it('listage paginé des clés d’un préfixe', async () => {
    seen.length = 0;
    const keys = await storage.listKeys('videos/a/hls/');
    expect(keys).toEqual(['videos/a/hls/master.m3u8', 'videos/a/hls/720/00001.ts']);
    expect(seen).toHaveLength(2);
    expect(seen[0].path).toBe('/f2f/');
    expect(seen[0].query.get('prefix')).toBe('videos/a/hls/');
    expect(seen[1].query.get('continuation-token')).toBe('page2');
    expect(seen[0].headers['x-amz-content-sha256']).toBeTruthy();
    expect(seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
  });

  it('suppression par lots : corps XML, Content-MD5 et pas d’erreur', async () => {
    seen.length = 0;
    const n = await storage.deletePrefix('videos/a/hls/');
    expect(n).toBe(2);
    const del = seen.find((s) => s.method === 'POST' && s.query.has('delete'));
    expect(del?.body).toContain('<Key>videos/a/hls/master.m3u8</Key>');
    expect(del?.headers['content-md5']).toBeTruthy();
  });

  it('ouverture, listage des parties paginé, finalisation et annulation d’un envoi', async () => {
    seen.length = 0;
    const id = await storage.createMultipart('videos/a/source-x.mp4', 'video/mp4');
    expect(id).toBe('up-42');
    const parts = await storage.listParts('videos/a/source-x.mp4', id);
    expect(parts.map((p) => [p.partNumber, p.etag, p.size])).toEqual([[1, '"e1"', 10], [2, '"e2"', 5]]);
    await storage.completeMultipart('videos/a/source-x.mp4', id, parts);
    const complete = seen.find((s) => s.method === 'POST' && s.query.has('uploadId'));
    expect(complete?.body).toContain('<PartNumber>1</PartNumber>');
    await storage.abortMultipart('videos/a/source-x.mp4', id);
    expect(seen.some((s) => s.method === 'DELETE' && s.query.get('uploadId') === 'up-42')).toBe(true);
  });

  it('URL de partie pré-signée : numéro de partie et identifiant d’envoi dans l’URL', () => {
    const url = new URL(storage.presignPart('videos/a/source-x.mp4', 'up-42', 7, 900));
    expect(url.searchParams.get('partNumber')).toBe('7');
    expect(url.searchParams.get('uploadId')).toBe('up-42');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });
});
