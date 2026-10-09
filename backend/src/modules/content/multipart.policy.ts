/**
 * Envoi par parties (étape 10, lot 3) : règles pures, partagées avec le mobile (même découpage).
 * Contraintes S3 : chaque partie (sauf la dernière) fait au moins 5 Mo ; au plus 10 000 parties.
 */
export const MIB = 1_048_576;
export const MIN_PART_BYTES = 5 * MIB;
export const MAX_PARTS = 10_000;
export const PREFERRED_PART_BYTES = 8 * MIB;

export function multipartPlan(sizeBytes: number, preferredPartBytes: number = PREFERRED_PART_BYTES): { partSizeBytes: number; partCount: number } {
  let partSizeBytes = Math.max(MIN_PART_BYTES, preferredPartBytes);
  while (Math.ceil(sizeBytes / partSizeBytes) > MAX_PARTS) partSizeBytes *= 2;
  return { partSizeBytes, partCount: Math.max(1, Math.ceil(sizeBytes / partSizeBytes)) };
}

/** Octets couverts par la partie `partNumber` (1 à n) : [start, end[. */
export function partRange(sizeBytes: number, partSizeBytes: number, partNumber: number): { start: number; end: number } {
  const start = (partNumber - 1) * partSizeBytes;
  return { start, end: Math.min(sizeBytes, start + partSizeBytes) };
}

export const isValidPartNumber = (partNumber: number, partCount: number) => Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= partCount;

/** Numéros des parties (1 à partCount) qui n'ont pas encore été reçues. */
export function missingParts(received: number[], partCount: number): number[] {
  const have = new Set(received);
  const out: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!have.has(n)) out.push(n);
  return out;
}
