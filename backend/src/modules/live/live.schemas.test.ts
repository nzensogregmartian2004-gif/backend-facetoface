import { describe, expect, it } from 'vitest';
import { chatSchema, createLiveSchema, reactionSchema } from './live.schemas';

describe('Live schemas', () => {
  it('accepts a public live scheduled in the future', () => {
    const parsed = createLiveSchema.parse({
      title: 'Concert',
      visibility: 'PUBLIC',
      scheduledAt: '2030-01-01T20:00:00.000Z',
    });
    expect(parsed.title).toBe('Concert');
    expect(parsed.scheduledAt).toBeInstanceOf(Date);
  });

  it('rejects an empty chat message', () => {
    expect(() => chatSchema.parse({ text: '   ' })).toThrow();
  });

  it('accepts supported live reactions only', () => {
    expect(reactionSchema.parse({ type: 'FIRE' }).type).toBe('FIRE');
    expect(() => reactionSchema.parse({ type: 'CLAP' })).toThrow();
  });
});
