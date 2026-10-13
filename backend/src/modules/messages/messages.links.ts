const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Liens présents dans un texte, dans l'ordre, sans doublon. La ponctuation finale n'en fait pas partie. */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?)]+$/, '')))];
}
