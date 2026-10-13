/** Taille maximale d'un aperçu flouté (miniature), en octets. */
export const PREVIEW_MAX_BYTES = 200_000;

/** Une clé d'aperçu doit appartenir à CET expéditeur et CETTE conversation, et être une image JPEG. */
export function isPreviewKeyFor(key: string, conversationId: string, senderId: string): boolean {
  return key.startsWith(`messages/${conversationId}/${senderId}/`) && /\.jpe?g$/i.test(key) && !key.includes('..');
}
