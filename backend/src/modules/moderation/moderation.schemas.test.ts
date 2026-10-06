import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const actionSchema = z.object({
  targetType: z.enum(['USER','VIDEO','SHORT','LIVE','COMMENT','MESSAGE','PAID_CONTENT']),
  targetId: z.string().min(1).max(64),
  action: z.enum(['WARNING','HIDE','UNHIDE','REMOVE','RESTORE','SUSPEND','BAN','UNSUSPEND','UNBAN','DISABLE_MONETIZATION','ENABLE_MONETIZATION']),
  reason: z.string().trim().min(3).max(500),
  reportId: z.string().min(1).max(64).optional(),
});

describe('moderation action contract', () => {
  it('accepts every moderation target and its supported action families', () => {
    const cases = [
      ['USER', ['WARNING','HIDE','UNHIDE','SUSPEND','BAN','UNSUSPEND','UNBAN','DISABLE_MONETIZATION','ENABLE_MONETIZATION']],
      ['VIDEO', ['HIDE','UNHIDE','REMOVE','RESTORE']],
      ['SHORT', ['HIDE','UNHIDE','REMOVE','RESTORE']],
      ['LIVE', ['HIDE','UNHIDE','REMOVE','RESTORE']],
      ['COMMENT', ['HIDE','UNHIDE','REMOVE','RESTORE']],
      ['MESSAGE', ['HIDE','UNHIDE','REMOVE','RESTORE']],
      ['PAID_CONTENT', ['HIDE','UNHIDE','REMOVE','RESTORE']],
    ] as const;
    for (const [targetType, actions] of cases) {
      for (const action of actions) {
        expect(actionSchema.safeParse({ targetType, targetId: 'target-1', action, reason: 'Violation des règles' }).success).toBe(true);
      }
    }
  });

  it('rejects empty or missing reasons', () => {
    expect(actionSchema.safeParse({ targetType: 'VIDEO', targetId: 'v1', action: 'REMOVE', reason: '' }).success).toBe(false);
    expect(actionSchema.safeParse({ targetType: 'VIDEO', targetId: 'v1', action: 'REMOVE' }).success).toBe(false);
  });
});
