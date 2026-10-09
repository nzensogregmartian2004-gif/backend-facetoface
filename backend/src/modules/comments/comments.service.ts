import type { Comment, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { forbidden, notFound } from '../../utils/errors';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { serializePublic } from '../../utils/serializers';
import { blockedIdsFor, loadInteractive } from '../content/access';
import { repo, type Kind } from '../content/types';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { objectStorage } from '../../utils/objectStorage';
import { randomToken } from '../../utils/crypto';
import { badRequest, conflict } from '../../utils/errors';
import { MESSAGE_AUDIO_MIME } from '../messages/messages.schemas';

const dropObject = async (key: string | null | undefined) => { if (key) { try { await objectStorage.delete(key); } catch { /* nettoyage au mieux */ } } };
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

type CommentWithAuthor = Comment & { author: User };

const serialize = (c: CommentWithAuthor, viewer: User, contentOwnerId: string) => ({
  id: c.id,
  text: c.text,
  /** Vocal : URL TOUJOURS signée (jamais le CDN public) : le commentaire n'est visible que là où le contenu l'est. */
  audio: c.audioKey ? { url: objectStorage.privateReadUrl(c.audioKey) || null, mimeType: c.audioMime, sizeBytes: c.audioSize, durationMs: c.audioDurationMs } : null,
  createdAt: c.createdAt,
  author: serializePublic(c.author),
  canDelete: c.authorId === viewer.id || contentOwnerId === viewer.id,
});

/** Commentaires du plus récent au plus ancien. Les commentaires d'utilisateurs bloqués (dans un sens ou dans l'autre) sont masqués. */
export async function list(viewer: User, kind: Kind, id: string, o: { cursor?: string; limit: number }) {
  const content = await loadInteractive(viewer, kind, id);
  if (!content.allowComments) return { items: [], nextCursor: null, allowComments: false };
  const blocked = await blockedIdsFor(viewer.id);
  const cursorId = readIdCursor(o.cursor);
  const rows: CommentWithAuthor[] = await prisma.comment.findMany({
    where: { targetType: kind, targetId: id, deletedAt: null, moderationStatus: 'ACTIVE', author: { status: 'ACTIVE', profileModerationStatus: 'ACTIVE' }, ...(blocked.length ? { authorId: { notIn: blocked } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { author: true },
  });
  const page = rows.slice(0, o.limit);
  return { items: page.map((c) => serialize(c, viewer, content.authorId)), nextCursor: rows.length > o.limit ? idCursor(page[page.length - 1].id) : null, allowComments: true };
}

/** Demande d'envoi d'un vocal de commentaire : URL de téléversement vers le stockage privé, clé à rattacher ensuite au commentaire. */
export async function audioUploadUrl(viewer: User, b: { targetType: 'VIDEO' | 'SHORT'; targetId: string; contentType: string; sizeBytes: number }) {
  const ext = MESSAGE_AUDIO_MIME[b.contentType];
  if (!ext) throw badRequest('UNSUPPORTED_AUDIO', 'Format non pris en charge (vocaux M4A, AAC ou MP3)');
  if (b.sizeBytes > env.COMMENT_AUDIO_MAX_BYTES) throw badRequest('FILE_TOO_LARGE', `Vocal trop volumineux (${Math.floor(env.COMMENT_AUDIO_MAX_BYTES / 1_048_576)} Mo maximum)`);
  const content = await loadInteractive(viewer, b.targetType, b.targetId); // 404 si le contenu n'est pas visible
  if (!content.allowComments) throw forbidden('COMMENTS_DISABLED', 'Les commentaires sont désactivés sur ce contenu');
  const key = `comments/${viewer.id}/${randomToken(10)}.${ext}`;
  return { upload: { ...objectStorage.presignUpload(key, b.contentType, env.UPLOAD_URL_TTL_SECONDS), key } };
}

/** Vérifie qu'un vocal a bien été reçu : bon propriétaire (préfixe de clé), bon format, bonne taille. */
async function verifyAudio(viewer: User, key: string) {
  if (!key.startsWith(`comments/${viewer.id}/`)) throw badRequest('INVALID_AUDIO', 'Vocal invalide');
  const ext = key.split('.').pop() ?? '';
  const mime = Object.entries(MESSAGE_AUDIO_MIME).find(([, e]) => e === ext)?.[0];
  if (!mime) throw badRequest('INVALID_AUDIO', 'Vocal invalide');
  const info = await objectStorage.head(key);
  if (!info) throw conflict('UPLOAD_MISSING', "Le fichier n'a pas été reçu par le stockage");
  if (info.size < 1 || info.size > env.COMMENT_AUDIO_MAX_BYTES || (info.contentType && info.contentType.toLowerCase() !== mime)) {
    await dropObject(key);
    throw badRequest('INVALID_AUDIO', 'Fichier audio invalide');
  }
  return { key, mime, size: info.size };
}

export async function create(viewer: User, kind: Kind, id: string, input: { text?: string; audioKey?: string; durationMs?: number }) {
  const content = await loadInteractive(viewer, kind, id); // 404 si l'auteur vous a bloqué
  if (!content.allowComments) throw forbidden('COMMENTS_DISABLED', 'Les commentaires sont désactivés sur ce contenu');
  const audio = input.audioKey ? await verifyAudio(viewer, input.audioKey) : null;
  let created: CommentWithAuthor;
  try {
    created = await prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: {
          authorId: viewer.id, targetType: kind, targetId: id,
          text: input.text ?? null,
          ...(audio ? { audioKey: audio.key, audioMime: audio.mime, audioSize: audio.size, audioDurationMs: input.durationMs ?? null } : {}),
        },
        include: { author: true },
      });
      await repo(tx, kind).update({ where: { id }, data: { commentCount: { increment: 1 } } });
      return c;
    });
  } catch (e) {
    if (audio && isUnique(e)) throw conflict('AUDIO_ALREADY_USED', 'Ce vocal a déjà été publié');
    throw e;
  }
  return serialize(created, viewer, content.authorId);
}

/** Suppression douce, par l'auteur du commentaire ou par le propriétaire du contenu. Un tiers reçoit 404 (pas de fuite d'existence). */
export async function remove(viewer: User, commentId: string) {
  const c = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!c || c.deletedAt) throw notFound('Commentaire introuvable');
  const kind = c.targetType as Kind;
  const content = await repo(prisma, kind).findUnique({ where: { id: c.targetId }, select: { authorId: true } });
  const isOwner = content?.authorId === viewer.id;
  if (c.authorId !== viewer.id && !isOwner) throw notFound('Commentaire introuvable');
  const audioKey = c.audioKey;
  await prisma.$transaction(async (tx) => {
    const r = await tx.comment.updateMany({ where: { id: commentId, deletedAt: null }, data: { deletedAt: new Date(), audioKey: null, audioMime: null, audioSize: null, audioDurationMs: null } });
    if (r.count === 1 && content) await repo(tx, kind).update({ where: { id: c.targetId }, data: { commentCount: { decrement: 1 } } });
  });
  await dropObject(audioKey); // le vocal est effacé avec le commentaire
}
