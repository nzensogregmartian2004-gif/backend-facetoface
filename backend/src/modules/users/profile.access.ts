/**
 * Contrôle d'accès aux contenus d'un profil. Fonction pure, sans base : testée unitairement.
 * Un profil privé ne montre ses contenus (vidéos, Shorts, Lives, payants) qu'à lui-même et à ses abonnés (followers).
 */
export function contentLocked(target: { profileVisibility: string }, isSelf: boolean, isFollower: boolean): boolean {
  return target.profileVisibility === 'PRIVATE' && !isSelf && !isFollower;
}
