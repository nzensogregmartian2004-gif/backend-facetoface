/** Échappe les jokers LIKE (`%`, `_`) et le caractère d'échappement : « user_1 » ne doit pas trouver « userX1 ». */
export const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);
