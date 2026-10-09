import { describe, expect, it } from 'vitest';
import { receiptStatus } from '../src/modules/messages/messages.serializer';

const sent = new Date('2026-10-01T10:00:00Z');
const before = new Date(sent.getTime() - 1000);
const after = new Date(sent.getTime() + 1000);

describe('coches de réception', () => {
  it('envoyé tant que personne n’a reçu ; livré quand tous ont reçu ; lu quand le lecteur a lu', () => {
    expect(receiptStatus(sent, [])).toBe('SENT');
    expect(receiptStatus(sent, [{ lastReadAt: null, lastDeliveredAt: null, readReceipts: true }])).toBe('SENT');
    expect(receiptStatus(sent, [{ lastReadAt: null, lastDeliveredAt: after, readReceipts: true }])).toBe('DELIVERED');
    expect(receiptStatus(sent, [{ lastReadAt: after, lastDeliveredAt: null, readReceipts: true }])).toBe('READ');
  });
  it('lu seulement si tous les lecteurs ont lu ; un membre sans accusés n’est pas compté', () => {
    const readOne = { lastReadAt: after, lastDeliveredAt: after, readReceipts: true };
    const notRead = { lastReadAt: null, lastDeliveredAt: after, readReceipts: true };
    const noReceipts = { lastReadAt: null, lastDeliveredAt: after, readReceipts: false };
    expect(receiptStatus(sent, [readOne, notRead])).toBe('DELIVERED');
    expect(receiptStatus(sent, [noReceipts])).toBe('DELIVERED');
    expect(receiptStatus(sent, [readOne, noReceipts])).toBe('READ');
  });
  it('un accusé plus ancien que le message ne compte pas', () => {
    expect(receiptStatus(sent, [{ lastReadAt: before, lastDeliveredAt: before, readReceipts: true }])).toBe('SENT');
  });
});
