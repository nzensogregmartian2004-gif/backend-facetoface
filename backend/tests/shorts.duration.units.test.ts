import { describe, expect, it } from 'vitest';
import { normalizeEdit } from '../src/modules/content/edit.policy';

describe('durée des Shorts (sans découpage)', () => {
  it('un Short de 61 secondes est refusé même sans découpage', () => {
    expect(normalizeEdit(undefined, 61, 'SHORT', 60)).toMatchObject({ ok: false, code: 'SHORT_TOO_LONG' });
  });
  it('un Short de 60 secondes exactement est accepté', () => {
    expect(normalizeEdit(undefined, 60, 'SHORT', 60)).toMatchObject({ ok: true, effectiveSeconds: 60 });
  });
  it('une vidéo longue n’est pas soumise à la limite des Shorts', () => {
    expect(normalizeEdit(undefined, 3600, 'VIDEO', 60)).toMatchObject({ ok: true, effectiveSeconds: 3600 });
  });
});
