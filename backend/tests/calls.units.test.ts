import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { billCall, prepaidAmount, type BillingInput } from '../src/modules/calls/calls.billing';
import { signLivekitToken } from '../src/utils/callProvider';

const perMinute = (over: Partial<BillingInput> = {}): BillingInput => ({ pricingMode: 'PER_MINUTE', unitPriceFcfa: 500, requestedMinutes: 10, grossFcfa: 5000, commissionBps: 2000, ...over });
const perSession = (over: Partial<BillingInput> = {}): BillingInput => ({ pricingMode: 'PER_SESSION', unitPriceFcfa: 8000, requestedMinutes: 30, grossFcfa: 8000, commissionBps: 2000, ...over });

describe('prepaidAmount', () => {
  it('par minute = prix × minutes ; par session = prix de la session', () => {
    expect(prepaidAmount('PER_MINUTE', 500, 10)).toBe(5000);
    expect(prepaidAmount('PER_SESSION', 8000, 30)).toBe(8000);
  });
});

describe('billCall — par minute', () => {
  it('toute minute commencée est due', () => {
    expect(billCall(perMinute(), 61, 10)).toMatchObject({ billedMinutes: 2, consumedFcfa: 1000, refundFcfa: 4000, commissionFcfa: 200, creatorFcfa: 800 });
    expect(billCall(perMinute(), 60, 10)).toMatchObject({ billedMinutes: 1, consumedFcfa: 500 });
    expect(billCall(perMinute(), 125, 10)).toMatchObject({ billedMinutes: 3, consumedFcfa: 1500, refundFcfa: 3500, commissionFcfa: 300, creatorFcfa: 1200 });
  });
  it('plafonné aux minutes prépayées, jamais plus que le prépayé', () => {
    expect(billCall(perMinute(), 600, 10)).toMatchObject({ billedMinutes: 10, consumedFcfa: 5000, refundFcfa: 0 });
    expect(billCall(perMinute(), 99_999, 10)).toMatchObject({ billedMinutes: 10, consumedFcfa: 5000, refundFcfa: 0 });
  });
  it('coupure immédiate (sous le seuil facturable) : rien de consommé, tout à rembourser', () => {
    expect(billCall(perMinute(), 9, 10)).toEqual({ consumedFcfa: 0, refundFcfa: 5000, commissionFcfa: 0, creatorFcfa: 0, billedMinutes: 0 });
    expect(billCall(perMinute(), 0, 0)).toEqual({ consumedFcfa: 0, refundFcfa: 5000, commissionFcfa: 0, creatorFcfa: 0, billedMinutes: 0 });
    expect(billCall(perMinute(), 10, 10).consumedFcfa).toBe(500);
  });
});

describe('billCall — par session', () => {
  it('la session est due en entier dès qu’elle a réellement commencé', () => {
    expect(billCall(perSession(), 15, 10)).toMatchObject({ billedMinutes: 30, consumedFcfa: 8000, refundFcfa: 0, commissionFcfa: 1600, creatorFcfa: 6400 });
  });
  it('rien n’est dû si l’appel a été coupé tout de suite', () => {
    expect(billCall(perSession(), 3, 10)).toMatchObject({ consumedFcfa: 0, refundFcfa: 8000, creatorFcfa: 0 });
  });
});

describe('billCall — invariants (entiers FCFA)', () => {
  it('gross = consumed + refund et consumed = commission + créateur sur de nombreux cas', () => {
    let n = 0;
    for (const bps of [0, 1, 1500, 2000, 3333, 10_000]) {
      for (const unit of [100, 150, 333, 1000, 99_999]) {
        for (const minutes of [1, 2, 7, 30]) {
          for (const seconds of [0, 5, 10, 59, 60, 61, 119, 120, 599, 1800, 5000]) {
            const input = perMinute({ unitPriceFcfa: unit, requestedMinutes: minutes, grossFcfa: unit * minutes, commissionBps: bps });
            const b = billCall(input, seconds, 10);
            expect(b.consumedFcfa + b.refundFcfa).toBe(input.grossFcfa);
            expect(b.commissionFcfa + b.creatorFcfa).toBe(b.consumedFcfa);
            expect(b.consumedFcfa).toBeGreaterThanOrEqual(0);
            expect(b.refundFcfa).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(b.commissionFcfa) && Number.isInteger(b.creatorFcfa)).toBe(true);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  });
});

describe('signLivekitToken', () => {
  it('produit un JWT HS256 valide : signature, émetteur, identité, droits de salle, expiration', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const t = signLivekitToken({ apiKey: 'KEY', apiSecret: 'SECRET', identity: 'user_1', name: 'Alice', ttlSeconds: 600, video: { roomJoin: true, room: 'call_1' }, now });
    const [h, p, s] = t.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'KEY', sub: 'user_1', name: 'Alice', video: { roomJoin: true, room: 'call_1' } });
    expect(payload.exp - payload.nbf).toBe(600);
    expect(s).toBe(createHmac('sha256', 'SECRET').update(`${h}.${p}`).digest('base64url'));
    expect(signLivekitToken({ apiKey: 'KEY', apiSecret: 'AUTRE', identity: 'user_1', ttlSeconds: 600, video: {}, now }).split('.')[2]).not.toBe(s);
  });
});
