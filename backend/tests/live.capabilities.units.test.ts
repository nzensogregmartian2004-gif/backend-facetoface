import { describe, expect, it } from 'vitest';
import { liveCapabilities } from '../src/modules/live/live.capabilities';

describe('capacité vidéo du direct', () => {
  const full = { url: 'wss://example.livekit.cloud', apiKey: 'key', apiSecret: 'secret' };
  it('vidéo disponible quand les trois identifiants sont renseignés', () => {
    expect(liveCapabilities(full)).toEqual({ video: true });
  });
  it('vidéo indisponible si un identifiant manque', () => {
    expect(liveCapabilities({ ...full, url: undefined }).video).toBe(false);
    expect(liveCapabilities({ ...full, apiKey: null }).video).toBe(false);
    expect(liveCapabilities({ ...full, apiSecret: undefined }).video).toBe(false);
  });
  it('une valeur vide ou blanche compte comme absente', () => {
    expect(liveCapabilities({ ...full, url: '   ' }).video).toBe(false);
    expect(liveCapabilities({ ...full, apiKey: '' }).video).toBe(false);
  });
  it('aucune configuration : vidéo indisponible', () => {
    expect(liveCapabilities({})).toEqual({ video: false });
  });
});
