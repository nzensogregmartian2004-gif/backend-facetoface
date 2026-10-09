import { describe, expect, it } from 'vitest';
import { commentSchema } from '../src/modules/content/content.schemas';

describe('commentaire : texte ou vocal, jamais les deux', () => {
  it('accepte un texte seul ou une clé de vocal seule', () => {
    expect(commentSchema.safeParse({ text: 'bravo' }).success).toBe(true);
    expect(commentSchema.safeParse({ audioKey: 'comments/u/x.m4a', durationMs: 4000 }).success).toBe(true);
  });
  it('refuse les deux, aucun des deux, un texte vide ou une durée nulle', () => {
    expect(commentSchema.safeParse({ text: 'a', audioKey: 'comments/u/x.m4a', durationMs: 1000 }).success).toBe(false);
    expect(commentSchema.safeParse({}).success).toBe(false);
    expect(commentSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(commentSchema.safeParse({ audioKey: 'comments/u/x.m4a', durationMs: 0 }).success).toBe(false);
  });
});
