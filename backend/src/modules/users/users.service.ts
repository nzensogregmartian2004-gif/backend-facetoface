import bcrypt from 'bcryptjs';
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { serializePublic, serializeSelf } from '../../utils/serializers';
import { localStorage, sniffImage } from '../../utils/storage';

export type ProfilePatch = { displayName?: string; username?: string; bio?: string | null; country?: string | null; links?: string[] };
export type PrivacyPatch = { profileVisibility?: 'PUBLIC' | 'PRIVATE'; allowMessagesFrom?: 'EVERYONE' | 'FOLLOWERS' | 'NOBODY'; showOnlineStatus?: boolean };

export async function updateProfile(user: User, patch: ProfilePatch) {
  try {
    const u = await prisma.user.update({ where: { id: user.id }, data: patch });
    return serializeSelf(u);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict('USERNAME_TAKEN', 'Cet identifiant est déjà pris', { username: 'Déjà utilisé' });
    }
    throw e;
  }
}

export async function usernameAvailable(username: string, selfId?: string) {
  const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return !u || u.id === selfId;
}

export async function updatePreferences(user: User, patch: { preferredLanguage?: 'FR' | 'EN'; preferredCurrency?: string }) {
  return serializeSelf(await prisma.user.update({ where: { id: user.id }, data: patch }));
}

export async function updatePrivacy(user: User, patch: PrivacyPatch) {
  return serializeSelf(await prisma.user.update({ where: { id: user.id }, data: patch }));
}

export async function setCreator(user: User, enabled: boolean) {
  if (user.isCreator === enabled) return serializeSelf(user);
  return serializeSelf(await prisma.user.update({ where: { id: user.id }, data: enabled ? { isCreator: true, creatorActivatedAt: new Date() } : { isCreator: false } }));
}

export async function setAvatar(user: User, file: Buffer) {
  const ext = sniffImage(file);
  if (!ext) throw badRequest('INVALID_IMAGE', 'Image invalide (JPEG, PNG ou WebP uniquement)');
  const url = await localStorage.saveAvatar(user.id, file, ext);
  const u = await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
  if (user.avatarUrl) await localStorage.deleteByUrl(user.avatarUrl);
  return serializeSelf(u);
}

export async function removeAvatar(user: User) {
  const u = await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
  if (user.avatarUrl) await localStorage.deleteByUrl(user.avatarUrl);
  return serializeSelf(u);
}

async function requireTarget(viewer: User, targetId: string) {
  if (targetId === viewer.id) throw badRequest('CANNOT_TARGET_SELF', 'Action impossible sur votre propre compte');
  const t = await prisma.user.findUnique({ where: { id: targetId } });
  if (!t || t.status === 'DELETED') throw notFound('Utilisateur introuvable');
  return t;
}

export async function blockUser(viewer: User, targetId: string) {
  await requireTarget(viewer, targetId);
  await prisma.$transaction([
    prisma.block.upsert({ where: { blockerId_blockedId: { blockerId: viewer.id, blockedId: targetId } }, create: { blockerId: viewer.id, blockedId: targetId }, update: {} }),
    // Bloquer rompt les suivis dans les deux sens.
    prisma.follow.deleteMany({ where: { OR: [{ followerId: viewer.id, followingId: targetId }, { followerId: targetId, followingId: viewer.id }] } }),
  ]);
}

export async function unblockUser(viewer: User, targetId: string) {
  await prisma.block.deleteMany({ where: { blockerId: viewer.id, blockedId: targetId } });
}

export async function listBlocked(viewer: User) {
  const rows = await prisma.block.findMany({ where: { blockerId: viewer.id, blocked: { status: { not: 'DELETED' } } }, include: { blocked: true }, orderBy: { createdAt: 'desc' } });
  return rows.map((b) => ({ ...serializePublic(b.blocked, { blockedByMe: true }), blockedAt: b.createdAt }));
}

/** Suppression : le compte est anonymisé (traçabilité financière future) et toutes les sessions sont révoquées. */
export async function deleteAccount(user: User, password: string) {
  if (!(await bcrypt.compare(password, user.passwordHash))) throw badRequest('WRONG_PASSWORD', 'Mot de passe incorrect', { password: 'Incorrect' });
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'DELETED', deletedAt: new Date(),
        email: `deleted+${user.id}@deleted.invalid`, username: `deleted_${user.id.slice(-12)}`,
        displayName: 'Compte supprimé', avatarUrl: null, bio: null, country: null, links: [],
        isCreator: false, emailVerifiedAt: null,
        passwordHash: '!',
      },
    }),
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.oneTimeCode.deleteMany({ where: { userId: user.id } }),
    // Les contenus d'un compte supprimé disparaissent (suppression douce ; le nettoyage des fichiers est repris à l'étape 21).
    prisma.video.updateMany({ where: { authorId: user.id, status: { not: 'REMOVED' } }, data: { status: 'REMOVED', deletedAt: new Date() } }),
    prisma.short.updateMany({ where: { authorId: user.id, status: { not: 'REMOVED' } }, data: { status: 'REMOVED', deletedAt: new Date() } }),
    prisma.follow.deleteMany({ where: { OR: [{ followerId: user.id }, { followingId: user.id }] } }),
  ]);
  const { purgeSentMessages } = await import('../messages/messages.service.js');
  await purgeSentMessages(user.id);
  if (user.avatarUrl) await localStorage.deleteByUrl(user.avatarUrl);
}
