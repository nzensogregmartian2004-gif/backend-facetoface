/**
 * Rattrapage des hashtags et mentions des contenus publiés AVANT l'étape 12.
 *   npm run tags:backfill
 * Sans effet sur les contenus déjà à jour. Peut être relancé sans risque.
 */
import { prisma } from '../src/config/db';
import { syncContentTags } from '../src/modules/discovery/tags.service';
import type { Kind } from '../src/modules/content/types';

async function main() {
  let n = 0;
  for (const kind of ['VIDEO', 'SHORT'] as Kind[]) {
    const delegate: any = kind === 'VIDEO' ? prisma.video : prisma.short;
    const rows: { id: string }[] = await delegate.findMany({ where: { status: 'PUBLISHED', deletedAt: null }, select: { id: true } });
    for (const r of rows) {
      await syncContentTags(kind, r.id);
      n++;
    }
  }
  console.log(`${n} contenu(s) traité(s).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
