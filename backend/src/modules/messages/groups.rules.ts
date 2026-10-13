/**
 * Droit de publier dans une conversation. Dans un groupe où seuls les administrateurs publient,
 * un membre simple ne peut pas envoyer ; le propriétaire et les administrateurs peuvent.
 */
export function mayPostInGroup(i: { isGroup: boolean; adminsOnlyPosting: boolean; role: string; isOwner: boolean }): boolean {
  if (!i.isGroup || !i.adminsOnlyPosting) return true;
  return i.role === 'ADMIN' || i.isOwner;
}
