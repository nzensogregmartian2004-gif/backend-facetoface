import { z } from 'zod';
import { categorySchema, pageQuerySchema } from '../content/content.schemas';

/** `@` initial toléré (« @marie »). */
const querySchema = z.string().trim().max(80, '80 caractères maximum').transform((v) => v.replace(/^@+/, ''));

export const searchQuerySchema = pageQuerySchema.extend({
  q: querySchema.optional(),
  type: z.enum(['creators', 'users', 'videos', 'shorts']).default('creators'),
  sort: z.enum(['popular', 'recent', 'views']).optional(),
  category: categorySchema.optional(),
}).superRefine((v, ctx) => {
  const people = v.type === 'creators' || v.type === 'users';
  if (people && (v.q ?? '').length < 2) ctx.addIssue({ code: 'custom', path: ['q'], message: '2 caractères minimum' });
  if (!people && !(v.q ?? '').length && !v.category) ctx.addIssue({ code: 'custom', path: ['q'], message: 'Saisissez un mot-clé ou choisissez une catégorie' });
  if (people && v.sort === 'views') ctx.addIssue({ code: 'custom', path: ['sort'], message: 'Tri par vues indisponible pour les comptes' });
  if (people && v.category) ctx.addIssue({ code: 'custom', path: ['category'], message: 'Filtre de catégorie indisponible pour les comptes' });
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
