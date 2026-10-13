import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_BYTES, isPreviewKeyFor } from '../src/modules/messages/messages.preview';

describe('aperçu flouté des médias payants', () => {
  const conv = 'conv1';
  const me = 'user1';
  it('accepte une image émise pour cet expéditeur et cette conversation', () => {
    expect(isPreviewKeyFor(`messages/${conv}/${me}/abc.jpg`, conv, me)).toBe(true);
  });
  it('refuse une clé d’une autre conversation, d’un autre expéditeur, ou un autre format', () => {
    expect(isPreviewKeyFor(`messages/autre/${me}/abc.jpg`, conv, me)).toBe(false);
    expect(isPreviewKeyFor(`messages/${conv}/autre/abc.jpg`, conv, me)).toBe(false);
    expect(isPreviewKeyFor(`messages/${conv}/${me}/abc.png`, conv, me)).toBe(false);
  });
  it('refuse les remontées de chemin', () => {
    expect(isPreviewKeyFor(`messages/${conv}/${me}/../abc.jpg`, conv, me)).toBe(false);
  });
  it('la taille maximale reste une miniature', () => {
    expect(PREVIEW_MAX_BYTES).toBeLessThanOrEqual(200_000);
  });
});
