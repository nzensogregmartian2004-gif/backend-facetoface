/**
 * Purge des playlists et segments HLS PUBLICS déjà présents sur des contenus réservés
 * (payants, réservés aux abonnés, ou non publics). À lancer une fois, après le correctif de l'étape 10 (lot 2).
 *   npm run purge:hls                  → liste les contenus concernés, ne modifie rien
 *   npm run purge:hls -- --execute     → purge réellement (stockage puis base)
 * Une erreur de stockage arrête le script sur ce contenu : relancez-le, il reprend là où il s'est arrêté.
 */
import { prisma } from '../src/config/db';
import { isRestrictedContent, shouldPurgePublicHls } from '../src/modules/content/processing.policy';
import { KINDS, type Kind } from '../src/modules/content/types';
import { objectStorage } from '../src/utils/objectStorage';

async function main() {
  const execute = process.argv.includes('--execute');
  let total = 0;
  for (const kind of ['VIDEO', 'SHORT'] as Kind[]) {
    const delegate: any = kind === 'VIDEO' ? prisma.video : prisma.short;
    const rows: any[] = await delegate.findMany({
      where: { manifestKey: { not: null } },
      select: { id: true, manifestKey: true, videoKey: true, price: true, subscriptionOnly: true, visibility: true },
    });
    const targets = rows.filter((r) => shouldPurgePublicHls(
      { manifestKey: r.manifestKey, videoKey: r.videoKey },
      isRestrictedContent({ paid: r.price != null, subscriptionOnly: !!r.subscriptionOnly, visibility: r.visibility }),
    ));
    for (const r of targets) {
      total++;
      console.log(`${execute ? 'PURGE' : 'À purger'} ${kind} ${r.id}`);
      if (!execute) continue;
      await objectStorage.deletePrefix(`${KINDS[kind].keyPrefix}/${r.id}/hls/`);
      await prisma.videoVariant.deleteMany({ where: kind === 'VIDEO' ? { videoId: r.id } : { shortId: r.id } });
      await delegate.update({ where: { id: r.id }, data: { manifestKey: null } });
    }
  }
  console.log(`${total} contenu(s) ${execute ? 'purgé(s)' : 'à purger (relancer avec --execute)'}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
