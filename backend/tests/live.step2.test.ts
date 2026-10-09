import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/db';
import { publishToRoom } from '../src/realtime/realtime';
import { canJoinLiveRoom } from '../src/modules/live/live.service';
import { api, creatorSignedIn, resetDb, signedIn } from './helpers';

vi.mock('../src/realtime/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/realtime/realtime')>()),
  publishToRoom: vi.fn(),
  closeRoom: vi.fn(),
}));

beforeEach(async () => {
  await resetDb();
  vi.mocked(publishToRoom).mockClear();
});

type S = { user: { id: string; username: string }; auth: { Authorization: string } };

const createLive = async (host: S, access: 'EVERYONE' | 'SUBSCRIBERS') => {
  const r = await api().post('/api/live').set(host.auth).send({ title: 'Live de test', visibility: 'PUBLIC', access });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.live.id as string;
};
const giveCoins = (s: S, n: number) => prisma.coinWallet.upsert({ where: { userId: s.user.id }, create: { userId: s.user.id, balance: n }, update: { balance: n } });
const firstGift = async (s: S) => ((await api().get('/api/coins/catalog').set(s.auth)).body.gifts[0] as { id: string });
const gifts = (s: S, body: Record<string, unknown>) => api().post('/api/coins/gifts/send').set(s.auth).send(body);
const giftEventCalls = () => vi.mocked(publishToRoom).mock.calls.filter(([, ev]) => (ev as { type?: string }).type === 'GIFT_SENT');

describe('salle d’un Live : règle d’accès', () => {
  it('un Live réservé aux abonnés n’est accessible qu’à son hôte et à ses abonnés', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const liveId = await createLive(host, 'SUBSCRIBERS');
    expect(await canJoinLiveRoom(host.user.id, liveId)).toBe(true);
    expect(await canJoinLiveRoom(viewer.user.id, liveId)).toBe(false);
  });

  it('un Live ouvert à tous est accessible à tout utilisateur connecté', async () => {
    const host = await creatorSignedIn(1); const viewer = await signedIn(2);
    const liveId = await createLive(host, 'EVERYONE');
    expect(await canJoinLiveRoom(viewer.user.id, liveId)).toBe(true);
  });

  it('un Live inconnu n’est pas accessible', async () => {
    const viewer = await signedIn(2);
    expect(await canJoinLiveRoom(viewer.user.id, 'inconnu-0000')).toBe(false);
  });
});

describe('cadeaux en direct : GIFT_SENT', () => {
  it('un cadeau refusé (solde insuffisant) ne publie aucun GIFT_SENT', async () => {
    const host = await creatorSignedIn(1); const sender = await signedIn(2);
    const liveId = await createLive(host, 'EVERYONE');
    await giveCoins(sender, 0);
    const gift = await firstGift(sender);
    const r = await gifts(sender, { creatorId: host.user.id, giftId: gift.id, quantity: 1, liveId });
    expect(r.status).toBe(409);
    expect(giftEventCalls()).toHaveLength(0);
  });

  it('un cadeau accepté est publié dans la salle du Live, après la transaction', async () => {
    const host = await creatorSignedIn(1); const sender = await signedIn(2);
    const liveId = await createLive(host, 'EVERYONE');
    await giveCoins(sender, 1000);
    const gift = await firstGift(sender);
    const r = await gifts(sender, { creatorId: host.user.id, giftId: gift.id, quantity: 2, liveId });
    expect(r.status).toBe(201);
    expect(vi.mocked(publishToRoom)).toHaveBeenCalledWith(liveId, expect.objectContaining({ type: 'GIFT_SENT' }));
    const payload = giftEventCalls()[0][1] as { payload: { liveId: string; quantity: number; sender: { id: string } } };
    expect(payload.payload.liveId).toBe(liveId);
    expect(payload.payload.quantity).toBe(2);
    expect(payload.payload.sender.id).toBe(sender.user.id);
  });
});
