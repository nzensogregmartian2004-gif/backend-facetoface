import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../src/utils/cursor';

describe('Step 25 — optimisation invariants', () => {
  it('uses bounded opaque pagination cursors', () => {
    const cursor = encodeCursor({ o: 40 });
    expect(cursor.length).toBeLessThan(300);
  });

  it('keeps the feed candidate budget bounded', async () => {
    const { env } = await import('../src/config/env');
    expect(env.FEED_CANDIDATES).toBeGreaterThanOrEqual(20);
    expect(env.FEED_CANDIDATES).toBeLessThanOrEqual(1000);
  });
});
