/**
 * Lecture et écriture du XML des réponses S3 (listage, envoi par parties, suppression par lots).
 * Fonctions pures, sans réseau : testables sans stockage réel.
 */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const SPECIAL: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => SPECIAL[c]);
export const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENT[e]);

const blocks = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const all = (xml: string, name: string): string[] => blocks(xml, name).map(unescapeXml);
const one = (xml: string, name: string): string | null => all(xml, name)[0] ?? null;

export function parseListKeys(xml: string) {
  return { keys: all(xml, 'Key'), truncated: one(xml, 'IsTruncated') === 'true', nextToken: one(xml, 'NextContinuationToken') };
}

export function parseUploadId(xml: string): string {
  const id = one(xml, 'UploadId');
  if (!id) throw new Error('UploadId absent de la réponse du stockage');
  return id;
}

export type PartRow = { partNumber: number; etag: string; size: number };

export function parseListParts(xml: string) {
  const parts: PartRow[] = blocks(xml, 'Part').map((b) => ({
    partNumber: Number(one(b, 'PartNumber')),
    etag: one(b, 'ETag') ?? '',
    size: Number(one(b, 'Size') ?? 0),
  }));
  return { parts, truncated: one(xml, 'IsTruncated') === 'true', nextMarker: one(xml, 'NextPartNumberMarker') };
}

export function buildCompleteXml(parts: { partNumber: number; etag: string }[]): string {
  const items = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
    .join('');
  return `<CompleteMultipartUpload>${items}</CompleteMultipartUpload>`;
}

export function buildDeleteXml(keys: string[]): string {
  return `<Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`;
}

/** Erreurs renvoyées par une suppression par lots (mode silencieux : seules les erreurs apparaissent). */
export function parseDeleteErrors(xml: string) {
  return blocks(xml, 'Error').map((b) => ({ key: one(b, 'Key'), code: one(b, 'Code') }));
}

/** S3 peut répondre 200 à une finalisation tout en envoyant une erreur dans le corps. */
export const hasS3Error = (xml: string) => /<Error>/.test(xml);
