import type { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { randomToken } from '../../utils/crypto';
import { objectStorage } from '../../utils/objectStorage';
import { serializePublic } from '../../utils/serializers';
import { POST_IMAGE_MAX_BYTES } from './posts.schemas';

type PostWithAuthor = Prisma.PostGetPayload<{ include: { author: true } }>;

/** Résultats d'un sondage : votes par option, total, et le choix de la personne qui consulte (null si pas encore voté). */
export type PollResults = { counts: number[]; total: number; myVote: number | null };

/** Types d'image acceptés pour un post, et leur extension. */
const POST_IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const dropObject = async (key: string | null | undefined) => { if (key) { try { await objectStorage.delete(key); } catch { /* nettoyage au mieux */ } } };

const serialize = (p: PostWithAuthor, pollResults: PollResults | null) => ({
  id: p.id,
  text: p.text,
  /** Options du sondage (null si le post n'a pas de sondage). */
  poll: (p.pollOptions as string[] | null) ?? null,
  pollResults,
  /** Image du post (URL publique), ou null. */
  imageUrl: p.imageKey ? objectStorage.readUrl(p.imageKey) || null : null,
  visibility: p.visibility,
  createdAt: p.createdAt,
  author: serializePublic(p.author),
});

/**
 * Sérialise des posts avec leurs résultats de sondage. Deux requêtes groupées pour toute la page :
 * totaux par option, et choix de la personne qui consulte.
 */
async function serializeMany(viewer: User, posts: PostWithAuthor[]) {
  const pollIds = posts.filter((p) => p.pollOptions !== null).map((p) => p.id);
  // Pas d'annotation sur l'appel : elle ferait déduire à Prisma un type de retour erroné (TS2345).
  const groupedRows = pollIds.length
    ? await prisma.postVote.groupBy({ by: ['postId', 'optionIndex'], where: { postId: { in: pollIds } }, _count: { _all: true } })
    : [];
  const grouped: { postId: string; optionIndex: number; _count: { _all: number } }[] = groupedRows;
  const mine: { postId: string; optionIndex: number }[] = pollIds.length
    ? await prisma.postVote.findMany({ where: { userId: viewer.id, postId: { in: pollIds } }, select: { postId: true, optionIndex: true } })
    : [];

  return posts.map((p) => {
    const options = (p.pollOptions as string[] | null) ?? null;
    if (!options) return serialize(p, null);
    const counts = options.map((_, i) => grouped.find((g) => g.postId === p.id && g.optionIndex === i)?._count._all ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const myVote = mine.find((m) => m.postId === p.id)?.optionIndex ?? null;
    return serialize(p, { counts, total, myVote });
  });
}

/** URL de téléversement d'une image de post : le fichier part directement vers le stockage, comme les vocaux de commentaires. */
export async function imageUploadUrl(viewer: User, b: { contentType: string; sizeBytes: number }) {
  const ext = POST_IMAGE_EXT[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_IMAGE', 'Format non pris en charge (JPEG, PNG ou WebP)');
  if (b.sizeBytes > POST_IMAGE_MAX_BYTES) throw badRequest('FILE_TOO_LARGE', 'Image trop lourde (5 Mo maximum)');
  const key = `posts/${viewer.id}/${randomToken(10)}.${ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

/** Vérifie qu'une image a bien été reçue : bon propriétaire (préfixe de clé), bon format, bonne taille. */
async function verifyImage(viewer: User, key: string) {
  if (!key.startsWith(`posts/${viewer.id}/`)) throw badRequest('INVALID_IMAGE', 'Image invalide');
  const info = await objectStorage.head(key);
  if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
  const typeOk = !info.contentType || Object.keys(POST_IMAGE_EXT).includes(info.contentType.toLowerCase());
  if (info.size < 1 || info.size > POST_IMAGE_MAX_BYTES || !typeOk) {
    await dropObject(key);
    throw badRequest('INVALID_IMAGE', 'Image invalide');
  }
}

/** Fil public : posts non supprimés, non privés, de comptes actifs ; du plus récent au plus ancien. */
export async function list(viewer: User, o: { cursor?: string; limit: number }) {
  const cursorId = readIdCursor(o.cursor);
  const rows = await prisma.post.findMany({
    where: { deletedAt: null, visibility: 'PUBLIC', author: { status: 'ACTIVE' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: true },
  });
  const page = rows.slice(0, o.limit);
  return {
    items: await serializeMany(viewer, page),
    nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null,
  };
}

/**
 * Posts d'un compte, pour son profil. Le compte doit être actif. Un profil privé n'est visible
 * que de ses abonnés (et de soi-même). Les visiteurs ne voient que les posts publics.
 */
export async function listByAuthor(viewer: User, username: string, o: { cursor?: string; limit: number }) {
  const author = await prisma.user.findFirst({ where: { username, status: 'ACTIVE' }, select: { id: true, profileVisibility: true } });
  if (!author) throw notFound('Utilisateur introuvable');
  const isSelf = author.id === viewer.id;
  if (!isSelf && author.profileVisibility === 'PRIVATE') {
    const follows = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewer.id, followingId: author.id } }, select: { id: true } });
    if (!follows) return { items: [], nextCursor: null };
  }
  const cursorId = readIdCursor(o.cursor);
  const rows = await prisma.post.findMany({
    where: { authorId: author.id, deletedAt: null, ...(isSelf ? {} : { visibility: 'PUBLIC' }) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: true },
  });
  const page = rows.slice(0, o.limit);
  return {
    items: await serializeMany(viewer, page),
    nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null,
  };
}

/** Publie un post : texte, sondage et image facultatifs. */
export async function create(user: User, input: { text: string; poll?: string[]; visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; imageKey?: string }) {
  if (input.imageKey) await verifyImage(user, input.imageKey);
  const post = await prisma.post.create({
    data: {
      authorId: user.id,
      text: input.text,
      pollOptions: input.poll ?? Prisma.JsonNull,
      visibility: input.visibility ?? 'PUBLIC',
      imageKey: input.imageKey ?? null,
    },
    include: { author: true },
  });
  return (await serializeMany(user, [post]))[0];
}

/** Vote sur le sondage d'un post. Un seul vote par personne : une fois voté, le choix ne change plus. */
export async function vote(viewer: User, id: string, option: number) {
  const post = await prisma.post.findFirst({ where: { id, deletedAt: null }, include: { author: true } });
  if (!post) throw notFound('Post introuvable');
  if (post.visibility === 'PRIVATE' && post.authorId !== viewer.id) throw notFound('Post introuvable');
  const options = (post.pollOptions as string[] | null) ?? null;
  if (!options) throw badRequest('NO_POLL', "Ce post n'a pas de sondage");
  if (option < 0 || option >= options.length) throw badRequest('INVALID_OPTION', 'Option inconnue');
  try {
    await prisma.postVote.create({ data: { postId: id, userId: viewer.id, optionIndex: option } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('ALREADY_VOTED', 'Vous avez déjà voté');
    throw e;
  }
  return (await serializeMany(viewer, [post]))[0];
}

/** Suppression douce, par l'auteur uniquement. Un autre compte reçoit 404. L'image est effacée avec le post. */
export async function remove(user: User, id: string) {
  const post = await prisma.post.findFirst({ where: { id, authorId: user.id, deletedAt: null }, select: { id: true, imageKey: true } });
  if (!post) throw notFound('Post introuvable');
  await prisma.post.update({ where: { id: post.id }, data: { deletedAt: new Date(), imageKey: null } });
  await dropObject(post.imageKey);
}
