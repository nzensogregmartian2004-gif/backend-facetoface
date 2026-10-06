import type { User } from '@prisma/client';
import { toDateOnly } from './dates';

/** Données du compte, visibles uniquement par son propriétaire. */
export const serializeSelf = (u: User) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl,
  bio: u.bio,
  country: u.country,
  links: u.links,
  birthDate: toDateOnly(u.birthDate),
  isCreator: u.isCreator,
  emailVerified: !!u.emailVerifiedAt,
  preferredLanguage: u.preferredLanguage,
  preferredCurrency: u.preferredCurrency,
  privacy: { profileVisibility: u.profileVisibility, allowMessagesFrom: u.allowMessagesFrom, showOnlineStatus: u.showOnlineStatus },
  createdAt: u.createdAt,
});

/** Profil public : jamais d'e-mail, de date de naissance ni de statut. */
export const serializePublic = (u: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'bio' | 'country' | 'links' | 'isCreator' | 'profileVisibility' | 'createdAt'>, opts: { blockedByMe?: boolean } = {}) => {
  const limited = u.profileVisibility === 'PRIVATE';
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: limited ? null : u.bio,
    country: limited ? null : u.country,
    links: limited ? [] : u.links,
    isCreator: u.isCreator,
    isPrivate: limited,
    createdAt: u.createdAt,
    isBlockedByMe: !!opts.blockedByMe,
  };
};
