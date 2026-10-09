import { describe, expect, it } from 'vitest';
import { MIB, MIN_PART_BYTES, MAX_PARTS, isValidPartNumber, missingParts, multipartPlan, partRange } from '../src/modules/content/multipart.policy';
import { buildCompleteXml, buildDeleteXml, hasS3Error, parseDeleteErrors, parseListKeys, parseListParts, parseUploadId } from '../src/utils/s3xml';

describe('étape 10 lot 3 — découpage de l’envoi par parties', () => {
  it('1 Go : parties de 8 Mo, 128 parties', () => {
    expect(multipartPlan(1024 * MIB)).toEqual({ partSizeBytes: 8 * MIB, partCount: 128 });
  });
  it('jamais moins de 5 Mo par partie, même si on demande moins', () => {
    expect(multipartPlan(100 * MIB, MIB).partSizeBytes).toBe(MIN_PART_BYTES);
  });
  it('au plus 10 000 parties : la taille de partie double si besoin', () => {
    const plan = multipartPlan(100 * 1024 * MIB, MIN_PART_BYTES);
    expect(plan.partCount).toBeLessThanOrEqual(MAX_PARTS);
    expect(plan.partSizeBytes).toBe(20 * MIB);
  });
  it('un petit fichier tient en une seule partie', () => {
    expect(multipartPlan(3 * MIB)).toEqual({ partSizeBytes: 8 * MIB, partCount: 1 });
  });
  it('la dernière partie couvre exactement le reste, sans chevauchement', () => {
    const size = 20 * MIB + 123;
    const plan = multipartPlan(size);
    expect(plan.partCount).toBe(3);
    const ranges = Array.from({ length: plan.partCount }, (_, i) => partRange(size, plan.partSizeBytes, i + 1));
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(size);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
  });
  it('numéros de partie valides : entiers de 1 à partCount', () => {
    expect(isValidPartNumber(1, 3)).toBe(true);
    expect(isValidPartNumber(3, 3)).toBe(true);
    expect(isValidPartNumber(0, 3)).toBe(false);
    expect(isValidPartNumber(4, 3)).toBe(false);
    expect(isValidPartNumber(1.5, 3)).toBe(false);
  });
  it('parties manquantes', () => {
    expect(missingParts([1, 3], 4)).toEqual([2, 4]);
    expect(missingParts([1, 2, 3, 4], 4)).toEqual([]);
  });
});

describe('étape 10 lot 3 — XML du stockage', () => {
  it('lit les clés d’une page de listage, avec pagination', () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;en</NextContinuationToken>
      <Contents><Key>videos/a/hls/master.m3u8</Key></Contents><Contents><Key>videos/a/hls/720/a&amp;b.ts</Key></Contents></ListBucketResult>`;
    const page = parseListKeys(xml);
    expect(page.keys).toEqual(['videos/a/hls/master.m3u8', 'videos/a/hls/720/a&b.ts']);
    expect(page.truncated).toBe(true);
    expect(page.nextToken).toBe('tok&en');
  });
  it('lit l’identifiant d’un envoi par parties', () => {
    expect(parseUploadId('<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>abc123XYZ</UploadId></InitiateMultipartUploadResult>')).toBe('abc123XYZ');
    expect(() => parseUploadId('<Error><Code>AccessDenied</Code></Error>')).toThrow();
  });
  it('lit les parties reçues avec leur ETag et leur taille', () => {
    const xml = `<ListPartsResult><IsTruncated>false</IsTruncated>
      <Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>8388608</Size></Part>
      <Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag><Size>100</Size></Part></ListPartsResult>`;
    const page = parseListParts(xml);
    expect(page.parts).toEqual([
      { partNumber: 1, etag: '"e1"', size: 8388608 },
      { partNumber: 2, etag: '"e2"', size: 100 },
    ]);
    expect(page.truncated).toBe(false);
  });
  it('écrit la finalisation triée par numéro de partie', () => {
    const xml = buildCompleteXml([{ partNumber: 2, etag: '"b"' }, { partNumber: 1, etag: '"a"' }]);
    expect(xml.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(xml.indexOf('<PartNumber>2</PartNumber>'));
    expect(xml).toContain('<ETag>&quot;a&quot;</ETag>');
  });
  it('échappe les clés dans la suppression par lots', () => {
    const xml = buildDeleteXml(['videos/x/hls/a&b<c>.ts']);
    expect(xml).toContain('<Key>videos/x/hls/a&amp;b&lt;c&gt;.ts</Key>');
    expect(xml).toContain('<Quiet>true</Quiet>');
  });
  it('détecte les erreurs de suppression et de finalisation', () => {
    expect(parseDeleteErrors('<DeleteResult><Error><Key>k1</Key><Code>AccessDenied</Code></Error></DeleteResult>')).toEqual([{ key: 'k1', code: 'AccessDenied' }]);
    expect(parseDeleteErrors('<DeleteResult></DeleteResult>')).toEqual([]);
    expect(hasS3Error('<Error><Code>InternalError</Code></Error>')).toBe(true);
    expect(hasS3Error('<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>')).toBe(false);
  });
});
