import { describe, expect, it } from 'vitest';
import { sendMessageSchema, voteSchema } from '../src/modules/messages/messages.schemas';

const future = new Date(Date.now() + 86_400_000).toISOString();

describe('sondage', () => {
  it('accepte une question et deux options', () => {
    expect(sendMessageSchema.safeParse({ poll: { question: 'Où ?', options: ['A', 'B'] } }).success).toBe(true);
  });
  it('refuse moins de deux options et plus de dix', () => {
    expect(sendMessageSchema.safeParse({ poll: { question: 'Où ?', options: ['A'] } }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ poll: { question: 'Où ?', options: Array.from({ length: 11 }, (_, i) => `o${i}`) } }).success).toBe(false);
  });
  it('refuse un sondage accompagné de texte', () => {
    expect(sendMessageSchema.safeParse({ text: 'bonjour', poll: { question: 'Où ?', options: ['A', 'B'] } }).success).toBe(false);
  });
});

describe('événement', () => {
  it('accepte une date future', () => {
    expect(sendMessageSchema.safeParse({ event: { title: 'Réunion', startsAt: future } }).success).toBe(true);
  });
  it('refuse une date passée', () => {
    expect(sendMessageSchema.safeParse({ event: { title: 'Réunion', startsAt: '2020-01-01T10:00:00Z' } }).success).toBe(false);
  });
});

describe('localisation', () => {
  it('accepte des coordonnées valides', () => {
    expect(sendMessageSchema.safeParse({ location: { latitude: 0.39, longitude: 9.45 } }).success).toBe(true);
  });
  it('refuse des coordonnées hors limites', () => {
    expect(sendMessageSchema.safeParse({ location: { latitude: 91, longitude: 0 } }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ location: { latitude: 0, longitude: 181 } }).success).toBe(false);
  });
});

describe('vote', () => {
  it('exige au moins une option', () => {
    expect(voteSchema.safeParse({ optionIds: [] }).success).toBe(false);
    expect(voteSchema.safeParse({ optionIds: ['abc'] }).success).toBe(true);
  });
});
