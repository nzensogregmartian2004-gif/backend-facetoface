import { prisma } from '../../config/db';
import { repo, type Kind } from '../content/types';
import { extractHashtags, extractMentions } from './tags';

/**
 * Met à jour les hashtags et mentions d'un contenu à partir de son titre et de sa description.
 * Un contenu qui n'est pas publié n'a aucun tag : on efface alors ce qui restait. Les tags déjà présents sont conservés
 * (leur date reste celle de la première apparition, utile pour les tendances).
 */
export async function syncContentTags(kind: Kind, id: string) {
  const row = await repo(prisma, kind).findUnique({ where: { id }, select: { id: true, authorId: true, title: true, description: true, status: true, deletedAt: true } });
  if (!row || row.status !== 'PUBLISHED' || row.deletedAt) return clearContentTags(kind, id);
  const text = `${row.title}\n${row.description ?? ''}`;
  const tagNames = extractHashtags(text);
  const mentionNames = extractMentions(text);

  const tags = await Promise.all(tagNames.map((name) => prisma.hashtag.upsert({ where: { name }, create: { name }, update: {}, select: { id: true } })));
  const keepTagIds = tags.map((t) => t.id);
  await prisma.contentHashtag.deleteMany({ where: { contentType: kind, contentId: id, hashtagId: { notIn: keepTagIds } } });
  const already = new Set((await prisma.contentHashtag.findMany({ where: { contentType: kind, contentId: id }, select: { hashtagId: true } })).map((r) => r.hashtagId));
  await prisma.contentHashtag.createMany({
    data: keepTagIds.filter((h) => !already.has(h)).map((hashtagId) => ({ hashtagId, contentType: kind, contentId: id })),
    skipDuplicates: true,
  });

  // Mentions : seulement des comptes actifs existants, jamais l'auteur lui-même.
  const mentioned = mentionNames.length
    ? await prisma.user.findMany({ where: { username: { in: mentionNames }, status: 'ACTIVE', id: { not: row.authorId } }, select: { id: true } })
    : [];
  const keepUserIds = mentioned.map((u) => u.id);
  await prisma.mention.deleteMany({ where: { contentType: kind, contentId: id, mentionedUserId: { notIn: keepUserIds } } });
  await prisma.mention.createMany({ data: keepUserIds.map((mentionedUserId) => ({ contentType: kind, contentId: id, mentionedUserId })), skipDuplicates: true });
}

/** Efface hashtags et mentions d'un contenu (suppression, retrait de la publication). */
export async function clearContentTags(kind: Kind, id: string) {
  await prisma.contentHashtag.deleteMany({ where: { contentType: kind, contentId: id } });
  await prisma.mention.deleteMany({ where: { contentType: kind, contentId: id } });
}
