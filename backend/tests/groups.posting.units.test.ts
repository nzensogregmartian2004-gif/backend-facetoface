import { describe, expect, it } from 'vitest';
import { mayPostInGroup } from '../src/modules/messages/groups.rules';

describe('publication dans un groupe', () => {
  it('tout membre publie quand la règle est désactivée', () => {
    expect(mayPostInGroup({ isGroup: true, adminsOnlyPosting: false, role: 'MEMBER', isOwner: false })).toBe(true);
  });
  it('un membre simple ne publie pas quand seuls les admins publient', () => {
    expect(mayPostInGroup({ isGroup: true, adminsOnlyPosting: true, role: 'MEMBER', isOwner: false })).toBe(false);
  });
  it('les admins et le propriétaire publient toujours', () => {
    expect(mayPostInGroup({ isGroup: true, adminsOnlyPosting: true, role: 'ADMIN', isOwner: false })).toBe(true);
    expect(mayPostInGroup({ isGroup: true, adminsOnlyPosting: true, role: 'MEMBER', isOwner: true })).toBe(true);
  });
  it('la règle ne concerne pas les conversations privées', () => {
    expect(mayPostInGroup({ isGroup: false, adminsOnlyPosting: true, role: 'MEMBER', isOwner: false })).toBe(true);
  });
});
