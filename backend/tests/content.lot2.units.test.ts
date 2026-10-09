import { describe, expect, it } from 'vitest';
import { PROCESSING_STALE_MS, isProcessingStale, isRestrictedContent, shouldPurgePublicHls } from '../src/modules/content/processing.policy';

describe('étape 10 lot 2 — contenu réservé', () => {
  it('gratuit public : pas réservé (HLS public autorisé)', () => {
    expect(isRestrictedContent({ paid: false, subscriptionOnly: false, visibility: 'PUBLIC' })).toBe(false);
  });
  it('payant, abonnés seuls, non répertorié ou privé : réservé', () => {
    expect(isRestrictedContent({ paid: true, subscriptionOnly: false, visibility: 'PUBLIC' })).toBe(true);
    expect(isRestrictedContent({ paid: false, subscriptionOnly: true, visibility: 'PUBLIC' })).toBe(true);
    expect(isRestrictedContent({ paid: false, subscriptionOnly: false, visibility: 'UNLISTED' })).toBe(true);
    expect(isRestrictedContent({ paid: false, subscriptionOnly: false, visibility: 'PRIVATE' })).toBe(true);
  });
});

describe('étape 10 lot 2 — retrait des playlists publiques au verrouillage', () => {
  const published = { manifestKey: 'videos/v1/hls/master.m3u8', videoKey: 'videos/v1/source-abc.mp4' };
  it('contenu HLS public qui devient réservé : purge', () => {
    expect(shouldPurgePublicHls(published, true)).toBe(true);
  });
  it('contenu qui reste public : aucune purge', () => {
    expect(shouldPurgePublicHls(published, false)).toBe(false);
  });
  it('pas de manifeste (contenu réservé déjà traité) : rien à purger', () => {
    expect(shouldPurgePublicHls({ manifestKey: null, videoKey: 'videos/v1/source.mp4' }, true)).toBe(false);
  });
  it('mode mémoire : le manifeste est le fichier source, il ne doit jamais être supprimé', () => {
    const memory = { manifestKey: 'videos/v1/source.mp4', videoKey: 'videos/v1/source.mp4' };
    expect(shouldPurgePublicHls(memory, true)).toBe(false);
  });
});

describe('étape 10 lot 2 — traitement bloqué', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  it('un traitement récent n\'est pas bloqué', () => {
    expect(isProcessingStale(new Date(now - 60_000), now)).toBe(false);
  });
  it('un traitement sans signe de vie depuis plus du délai est bloqué', () => {
    expect(isProcessingStale(new Date(now - PROCESSING_STALE_MS - 1), now)).toBe(true);
  });
  it('le délai est de 15 minutes', () => {
    expect(PROCESSING_STALE_MS).toBe(15 * 60_000);
  });
});
