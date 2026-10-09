import { z } from 'zod';

/** Taille maximale d'une bannière (5 Mo). Plus large que l'avatar : le format est paysage. */
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Contenu mis en avant sur la chaîne. `contentId: null` retire la mise en avant.
 * Le type est obligatoire dès qu'un contenu est désigné ; l'appartenance et la publication sont vérifiées en service.
 */
export const featuredSchema = z.object({
  type: z.enum(['VIDEO', 'SHORT']).optional(),
  contentId: z.string().trim().min(1).max(64).nullable(),
}).strict().refine((v) => v.contentId === null || v.type !== undefined, {
  message: 'Le type de contenu est requis',
  path: ['type'],
});
