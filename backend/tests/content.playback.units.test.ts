import { describe, expect, it } from 'vitest';
import { playbackPlan } from '../src/modules/content/playback.policy';

const TTL = { standardTtl: 7200, paidTtl: 300 };
const base = { paid: false, subscriptionOnly: false, visibility: 'PUBLIC', hasCdn: true, hasManifest: true };

describe('étape 10 — mode de lecture', () => {
  it('gratuit public avec CDN et playlist : HLS public, durée standard', () => {
    expect(playbackPlan(base, TTL)).toEqual({ mode: 'HLS_PUBLIC', ttlSeconds: 7200 });
  });
  it('payant : jamais HLS public, URL signée de 300 secondes, même avec CDN', () => {
    expect(playbackPlan({ ...base, paid: true }, TTL)).toEqual({ mode: 'PROGRESSIVE_PRIVATE', ttlSeconds: 300 });
  });
  it('réservé aux abonnés : jamais l’URL publique du CDN, même gratuit', () => {
    expect(playbackPlan({ ...base, subscriptionOnly: true }, TTL).mode).toBe('PROGRESSIVE_PRIVATE');
  });
  it('non public : URL signée', () => {
    expect(playbackPlan({ ...base, visibility: 'UNLISTED' }, TTL).mode).toBe('PROGRESSIVE_PRIVATE');
  });
  it('gratuit public sans CDN ou sans playlist : fichier signé, pas d’adaptatif', () => {
    expect(playbackPlan({ ...base, hasCdn: false }, TTL).mode).toBe('PROGRESSIVE_PRIVATE');
    expect(playbackPlan({ ...base, hasManifest: false }, TTL).mode).toBe('PROGRESSIVE_PRIVATE');
  });
});
