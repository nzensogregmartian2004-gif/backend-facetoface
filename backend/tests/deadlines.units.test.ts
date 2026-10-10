import { describe, expect, it } from 'vitest';
import { canPurgeContent, canRespondToDispute, isDisputeAutoClosable } from '../src/modules/disputes/deadlines.rules';

const DAY = 86_400_000;
const opened = new Date('2026-10-01T10:00:00Z');
const open = { disputedAt: opened, disputeClosedAt: null, disputeRespondedAt: null };

describe('délai de réponse aux litiges', () => {
  it('le créateur peut répondre pendant les 3 jours', () => {
    expect(canRespondToDispute(open, new Date(opened.getTime() + 2 * DAY), 3)).toBe(true);
    expect(canRespondToDispute(open, new Date(opened.getTime() + 4 * DAY), 3)).toBe(false);
  });
  it('une seule réponse est possible', () => {
    expect(canRespondToDispute({ ...open, disputeRespondedAt: opened }, opened, 3)).toBe(false);
  });
  it('clôture automatique seulement sans réponse, après l’échéance', () => {
    expect(isDisputeAutoClosable(open, new Date(opened.getTime() + 4 * DAY), 3)).toBe(true);
    expect(isDisputeAutoClosable({ ...open, disputeRespondedAt: opened }, new Date(opened.getTime() + 4 * DAY), 3)).toBe(false);
    expect(isDisputeAutoClosable(open, new Date(opened.getTime() + 2 * DAY), 3)).toBe(false);
  });
});

describe('purge du contenu retiré', () => {
  const removed = new Date('2026-10-01T00:00:00Z');
  it('impossible avant le délai, possible après', () => {
    expect(canPurgeContent(removed, new Date(removed.getTime() + 29 * DAY), 30)).toBe(false);
    expect(canPurgeContent(removed, new Date(removed.getTime() + 30 * DAY), 30)).toBe(true);
  });
  it('impossible si le contenu n’a jamais été retiré', () => {
    expect(canPurgeContent(null, new Date(), 30)).toBe(false);
  });
});
