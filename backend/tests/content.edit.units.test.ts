import { describe, expect, it } from 'vitest';
import { normalizeEdit } from '../src/modules/content/edit.policy';

describe('étape 13 — découpage et couverture (règles pures)', () => {
  it('sans découpage : rien à appliquer, durée inchangée', () => {
    expect(normalizeEdit(undefined, 42, 'VIDEO', 60)).toEqual({ ok: true, effectiveSeconds: 42, trimStartMs: null, trimEndMs: null, coverMs: null });
  });
  it('découpage 2 s → 8 s d’une vidéo de 10 s : durée réelle de 6 s', () => {
    const r = normalizeEdit({ startMs: 2000, endMs: 8000 }, 10, 'VIDEO', 60);
    expect(r).toEqual({ ok: true, effectiveSeconds: 6, trimStartMs: 2000, trimEndMs: 8000, coverMs: null });
  });
  it('fin égale à la fin de la source (arrondi du mobile) : pas de découpage', () => {
    const r = normalizeEdit({ startMs: 0, endMs: 10_300 }, 10, 'VIDEO', 60);
    expect(r).toMatchObject({ ok: true, effectiveSeconds: 10, trimStartMs: null, trimEndMs: null });
  });
  it('couverture seule, sans découpage', () => {
    expect(normalizeEdit({ coverMs: 3000 }, 10, 'VIDEO', 60)).toMatchObject({ ok: true, trimStartMs: null, coverMs: 3000 });
  });
  it('couverture dans la vidéo découpée, pas au-delà', () => {
    expect(normalizeEdit({ startMs: 2000, endMs: 8000, coverMs: 5999 }, 10, 'VIDEO', 60)).toMatchObject({ ok: true, coverMs: 5999 });
    expect(normalizeEdit({ startMs: 2000, endMs: 8000, coverMs: 6000 }, 10, 'VIDEO', 60)).toMatchObject({ ok: false, code: 'COVER_OUT_OF_RANGE' });
  });
  it('début après la fin, ou fin au-delà de la durée : refusés', () => {
    expect(normalizeEdit({ startMs: 5000, endMs: 5000 }, 10, 'VIDEO', 60)).toMatchObject({ ok: false, code: 'EDIT_INVALID_RANGE' });
    expect(normalizeEdit({ startMs: 0, endMs: 15_000 }, 10, 'VIDEO', 60)).toMatchObject({ ok: false, code: 'EDIT_OUT_OF_RANGE' });
  });
  it('moins d’une seconde gardée : refusé', () => {
    expect(normalizeEdit({ startMs: 2000, endMs: 2500 }, 10, 'VIDEO', 60)).toMatchObject({ ok: false, code: 'EDIT_TOO_SHORT' });
  });
  it('Short : le découpage doit tenir sous la limite, même si la source est plus longue', () => {
    expect(normalizeEdit({ startMs: 0, endMs: 50_000 }, 90, 'SHORT', 60)).toMatchObject({ ok: true, effectiveSeconds: 50 });
    expect(normalizeEdit({ startMs: 10_000, endMs: 80_000 }, 90, 'SHORT', 60)).toMatchObject({ ok: false, code: 'SHORT_TOO_LONG' });
    // Un Short non découpé de plus de 60 s est refusé : la limite ne vaut que si elle s'applique à la source.
    expect(normalizeEdit(undefined, 90, 'SHORT', 60)).toMatchObject({ ok: false, code: 'SHORT_TOO_LONG' });
  });
});
