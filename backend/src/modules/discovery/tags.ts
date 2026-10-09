/**
 * Hashtags et mentions (étape 12) : extraction pure, sans base. Testable seule.
 * Un hashtag : « # » suivi de 2 à 30 lettres, chiffres ou « _ ». Un pseudo mentionné : « @ » suivi d'un pseudo valide
 * (mêmes règles que l'inscription : minuscules, chiffres, « _ » et « . », 3 à 20 caractères).
 */
export const MAX_TAGS_PER_CONTENT = 10;

const HASHTAG = /(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,30})/gu;
const MENTION = /(?<![\p{L}\p{N}_.@])@([A-Za-z0-9_.]{3,20})/gu;

/** Forme canonique d'un hashtag : minuscules, Unicode NFC (« Été » et « été » sont le même tag). */
export function normalizeTag(raw: string): string {
  return raw.normalize('NFC').toLowerCase();
}

export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG)) {
    const tag = normalizeTag(m[1]);
    if (!/\p{L}/u.test(tag)) continue; // « #2026 » seul n'est pas un thème
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS_PER_CONTENT) break;
  }
  return out;
}

export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[1].toLowerCase().replace(/\.+$/, '');
    if (name.length < 3 || name.includes('..') || name.startsWith('.')) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
