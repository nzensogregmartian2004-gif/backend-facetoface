import type { User } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authed, requireAuth } from '../../middleware/auth';
import { objectStorage } from '../../utils/objectStorage';
import { badRequest, notFound } from '../../utils/errors';
import { wrap } from '../../utils/async';
import { body } from '../../utils/validate';
import { getConfigValue } from '../config/config.service';
import { CONTENT_PURGE_DAYS_DEFAULT, canPurgeContent } from '../disputes/deadlines.rules';
import { audit } from './admin.service';
import { requireSuperAdmin } from './roles';

/**
 * Purge définitive d'un contenu retiré : réservée au super administrateur, et seulement après le délai de
 * conservation (réglage CONTENT.PURGE_AFTER_DAYS, 30 jours par défaut). Le contenu est masqué avant : il reste réversible.
 */
export async function purgeRemovedContent(admin: User, type: 'VIDEO' | 'SHORT', id: string, reason: string) {
  requireSuperAdmin(admin);
  const model: any = type === 'VIDEO' ? prisma.video : prisma.short;
  const row = await model.findUnique({ where: { id }, select: { id: true, status: true, removedAt: true, videoKey: true, thumbnailKey: true, manifestKey: true } });
  if (!row) throw notFound('Contenu introuvable');
  if (row.status !== 'REMOVED') throw badRequest('NOT_REMOVED', 'Seul un contenu retiré peut être purgé');
  const v = await getConfigValue<number>('CONTENT.PURGE_AFTER_DAYS', CONTENT_PURGE_DAYS_DEFAULT);
  const days = typeof v === 'number' && v > 0 ? v : CONTENT_PURGE_DAYS_DEFAULT;
  if (!canPurgeContent(row.removedAt, new Date(), days)) throw badRequest('PURGE_TOO_EARLY', `Purge possible ${days} jours après le retrait`);
  const keys: string[] = [row.videoKey, row.thumbnailKey, row.manifestKey].filter((k: string | null): k is string => !!k);
  for (const k of keys) await objectStorage.delete(k);
  // Dossier du contenu : supprimé seulement si son chemin contient l'identifiant, pour ne jamais effacer un autre contenu.
  const first = keys[0];
  if (first && first.includes('/') && first.includes(id)) await objectStorage.deletePrefix(first.slice(0, first.lastIndexOf('/') + 1));
  await model.update({ where: { id }, data: { videoKey: null, thumbnailKey: null, manifestKey: null } });
  await audit(admin.id, 'PURGE content', type, id, reason, { files: keys.length });
  return { purged: true };
}

export const contentPurgeRouter = Router();
contentPurgeRouter.use(requireAuth);
const purgeSchema = z.object({ reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300) }).strict();
/** Contenus retirés, avec leur date de retrait et le délai de purge. Réservé au super administrateur. */
contentPurgeRouter.get('/removed', wrap(async (req, res) => {
  requireSuperAdmin(authed(req).user);
  const v = await getConfigValue<number>('CONTENT.PURGE_AFTER_DAYS', CONTENT_PURGE_DAYS_DEFAULT);
  const days = typeof v === 'number' && v > 0 ? v : CONTENT_PURGE_DAYS_DEFAULT;
  const select = { id: true, removedAt: true, authorId: true, videoKey: true } as const;
  const [videos, shorts] = await Promise.all([
    prisma.video.findMany({ where: { status: 'REMOVED' }, orderBy: { removedAt: 'desc' }, take: 100, select }),
    prisma.short.findMany({ where: { status: 'REMOVED' }, orderBy: { removedAt: 'desc' }, take: 100, select }),
  ]);
  const items = [
    ...videos.map((i) => ({ id: i.id, type: 'VIDEO' as const, removedAt: i.removedAt, authorId: i.authorId, purged: !i.videoKey })),
    ...shorts.map((i) => ({ id: i.id, type: 'SHORT' as const, removedAt: i.removedAt, authorId: i.authorId, purged: !i.videoKey })),
  ];
  res.json({ purgeAfterDays: days, items });
}));
contentPurgeRouter.post('/videos/:id/purge', wrap(async (req, res) => {
  res.json(await purgeRemovedContent(authed(req).user, 'VIDEO', String(req.params.id), body(purgeSchema, req).reason));
}));
contentPurgeRouter.post('/shorts/:id/purge', wrap(async (req, res) => {
  res.json(await purgeRemovedContent(authed(req).user, 'SHORT', String(req.params.id), body(purgeSchema, req).reason));
}));
