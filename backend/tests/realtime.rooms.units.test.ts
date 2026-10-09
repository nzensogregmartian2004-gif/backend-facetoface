import { describe, expect, it } from 'vitest';
import { RoomRegistry, WindowLimiter } from '../src/realtime/rooms';

type C = { id: number; got: string[] };
const mk = (id: number): C => ({ id, got: [] });
const deliver = (label: string) => (c: C) => { c.got.push(label); };

describe('salles de diffusion', () => {
  it('n’envoie un événement qu’aux membres de la salle', () => {
    const r = new RoomRegistry<C>();
    const a = mk(1), b = mk(2), c = mk(3);
    r.join(a, 'live-1'); r.join(b, 'live-1'); r.join(c, 'live-2');
    expect(r.publish('live-1', deliver('chat'))).toBe(2);
    expect(a.got).toEqual(['chat']);
    expect(b.got).toEqual(['chat']);
    expect(c.got).toEqual([]);
  });

  it('un membre qui quitte ne reçoit plus rien ; quitter deux fois ne fait rien', () => {
    const r = new RoomRegistry<C>();
    const a = mk(1), b = mk(2);
    r.join(a, 'live-1'); r.join(b, 'live-1');
    expect(r.leave(a, 'live-1')).toBe(true);
    expect(r.leave(a, 'live-1')).toBe(false);
    r.publish('live-1', deliver('x'));
    expect(a.got).toEqual([]);
    expect(b.got).toEqual(['x']);
  });

  it('la fermeture d’une connexion la retire de toutes ses salles', () => {
    const r = new RoomRegistry<C>();
    const a = mk(1);
    r.join(a, 'live-1'); r.join(a, 'live-2');
    r.unregister(a);
    expect(r.isMember(a, 'live-1')).toBe(false);
    expect(r.isMember(a, 'live-2')).toBe(false);
    expect(r.size('live-1')).toBe(0);
  });

  it('une erreur d’écriture chez un membre n’empêche pas les autres de recevoir', () => {
    const r = new RoomRegistry<C>();
    const broken = mk(1), healthy = mk(2);
    r.join(broken, 'live-1'); r.join(healthy, 'live-1');
    const delivered = r.publish('live-1', (c) => { if (c.id === 1) throw new Error('socket fermé'); c.got.push('ok'); });
    expect(delivered).toBe(1);
    expect(healthy.got).toEqual(['ok']);
  });

  it('fermer une salle retire tous ses membres', () => {
    const r = new RoomRegistry<C>();
    r.join(mk(1), 'live-1'); r.join(mk(2), 'live-1');
    expect(r.close('live-1')).toBe(2);
    expect(r.size('live-1')).toBe(0);
    expect(r.publish('live-1', deliver('après'))).toBe(0);
  });

  it('rejoindre deux fois la même salle ne duplique pas la diffusion', () => {
    const r = new RoomRegistry<C>();
    const a = mk(1);
    expect(r.join(a, 'live-1')).toBe(true);
    expect(r.join(a, 'live-1')).toBe(false);
    r.publish('live-1', deliver('une fois'));
    expect(a.got).toEqual(['une fois']);
  });
});

describe('limiteur par connexion', () => {
  it('refuse au-delà du maximum dans la fenêtre, puis rétablit quand la fenêtre glisse', () => {
    const l = new WindowLimiter(2, 1000);
    expect(l.allow(0)).toBe(true);
    expect(l.allow(10)).toBe(true);
    expect(l.allow(20)).toBe(false);
    expect(l.allow(1005)).toBe(true);
  });
});
