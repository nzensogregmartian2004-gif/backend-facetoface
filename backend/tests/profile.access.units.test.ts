import { describe, expect, it } from 'vitest';
import { contentLocked } from '../src/modules/users/profile.access';

const PUBLIC = { profileVisibility: 'PUBLIC' };
const PRIVATE = { profileVisibility: 'PRIVATE' };

describe('contentLocked', () => {
  it('profil public : jamais verrouillé', () => {
    expect(contentLocked(PUBLIC, false, false)).toBe(false);
  });
  it('profil privé : verrouillé pour un spectateur sans lien', () => {
    expect(contentLocked(PRIVATE, false, false)).toBe(true);
  });
  it('profil privé : ouvert à un abonné (follower)', () => {
    expect(contentLocked(PRIVATE, false, true)).toBe(false);
  });
  it('profil privé : toujours ouvert à son propriétaire', () => {
    expect(contentLocked(PRIVATE, true, false)).toBe(false);
  });
});
