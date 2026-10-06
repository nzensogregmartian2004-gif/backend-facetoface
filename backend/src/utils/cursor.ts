import { badRequest } from './errors';

/** Curseurs de pagination opaques (base64url d'un petit objet JSON). */
export const encodeCursor = (v: Record<string, string | number>) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function decodeCursor(raw: string | undefined): Record<string, string | number> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string | number>;
  } catch { /* tombe sur l'erreur ci-dessous */ }
  throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
}

export const idCursor = (id: string) => encodeCursor({ i: id });
export function readIdCursor(raw: string | undefined): string | null {
  const c = decodeCursor(raw);
  if (!c) return null;
  if (typeof c.i !== 'string' || !c.i || c.i.length > 64) throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
  return c.i;
}
export function readOffsetCursor(raw: string | undefined): number {
  const c = decodeCursor(raw);
  if (!c) return 0;
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0 || c.o > 100_000) throw badRequest('INVALID_CURSOR', 'Curseur de pagination invalide');
  return c.o;
}
