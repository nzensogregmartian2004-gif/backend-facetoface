import type { User } from '@prisma/client';
import { prisma } from '../../config/db';
import { idCursor, readIdCursor } from '../../utils/cursor';
import { PUBLIC_AUTHOR_SELECT, serializeMany, type ContentDto } from '../content/content.serializer';
import { repo } from '../content/types';

/**
 * Bibliothèque : vidéos longues et Shorts enregistrés par le spectateur, du plus récent au plus ancien.
 * Un contenu supprimé, masqué ou devenu privé disparaît de la liste (il n'est plus exposé).
 */
export async function listSaved(viewer: User, o: { cursor?: string; limit: number }) {
  const cursorId = readIdCursor(o.cursor);
  const saves = await prisma.savedContent.findMany({
    where: { userId: viewer.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: o.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: { id: true, targetType: true, targetId: true },
  });
  const page = saves.slice(0, o.limit);

  // Chargement par type de contenu, puis remise dans l'ordre d'enregistrement.
  const found = new Map<string, ContentDto>();
  for (const kind of ['VIDEO', 'SHORT'] as const) {
    const ids = page.filter((s) => s.targetType === kind).map((s) => s.targetId);
    if (ids.length === 0) continue;
    const rows = await repo(prisma, kind).findMany({
      where: {
        id: { in: ids },
        status: 'PUBLISHED',
        deletedAt: null,
        OR: [{ visibility: { not: 'PRIVATE' } }, { authorId: viewer.id }],
      },
      include: { author: { select: PUBLIC_AUTHOR_SELECT } },
    });
    for (const dto of await serializeMany(kind, rows, viewer)) found.set(`${kind}:${dto.id}`, dto);
  }
  const items = page
    .map((s) => found.get(`${s.targetType}:${s.targetId}`))
    .filter((x): x is ContentDto => !!x);

  return { items, nextCursor: saves.length > o.limit ? idCursor(page[page.length - 1].id) : null };
}
