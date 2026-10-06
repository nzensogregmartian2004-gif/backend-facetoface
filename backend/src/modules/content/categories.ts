/** Catégories de contenu. Liste fixe pour l'étape 3 ; elle deviendra administrable avec le centre de configuration (étape 17). */
export const CATEGORIES = [
  { slug: 'music', name: 'Musique' },
  { slug: 'entertainment', name: 'Divertissement' },
  { slug: 'comedy', name: 'Humour' },
  { slug: 'education', name: 'Éducation' },
  { slug: 'tech', name: 'Technologie' },
  { slug: 'sport', name: 'Sport' },
  { slug: 'lifestyle', name: 'Style de vie' },
  { slug: 'food', name: 'Cuisine' },
  { slug: 'travel', name: 'Voyage' },
  { slug: 'news', name: 'Actualités' },
  { slug: 'gaming', name: 'Jeux vidéo' },
  { slug: 'fashion', name: 'Mode' },
  { slug: 'art', name: 'Art et création' },
  { slug: 'other', name: 'Autre' },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]['slug'];
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];
