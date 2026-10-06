import { createServer } from 'node:http';
import { createApp } from './app';
import { attachRealtime } from './realtime/realtime';
import { prisma } from './config/db';
import { env } from './config/env';
import { startCallSweeper } from './modules/calls/calls.service';
import { startReconciler } from './modules/payments/reconcile';

const server = createServer(createApp());
attachRealtime(server);
// Délais cohérents avec un load balancer (le défaut de Node, 5 s de keep-alive, provoque des 502 sporadiques derrière un proxy).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(env.PORT, () => console.log(`Face to Face API — ${env.PUBLIC_BASE_URL} (${env.NODE_ENV})`));

startReconciler(); // rapprochement des paiements restés PENDING (aucun effet avec PAYMENT_DRIVER=none)
startCallSweeper(); // sonneries expirées et durées maximales atteintes (aucun effet avec CALL_PROVIDER=none)

// Arrêt propre (déploiement, redémarrage) : on cesse d'accepter, on laisse finir les requêtes en cours
// (notamment les écritures financières), puis on ferme la base. Plafond de 25 s avant arrêt forcé.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[arrêt] ${signal} reçu : fin des requêtes en cours…`);
  const force = setTimeout(() => { console.error('[arrêt] délai dépassé : arrêt forcé'); process.exit(1); }, 25_000);
  force.unref();
  server.close(async () => {
    try { await prisma.$disconnect(); } finally { process.exit(0); }
  });
  server.closeIdleConnections?.();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Une promesse rejetée non gérée est journalisée (jamais silencieuse) ; une exception non interceptée arrête proprement le processus.
process.on('unhandledRejection', (reason) => console.error('[erreur] promesse rejetée non gérée :', reason));
process.on('uncaughtException', (err) => { console.error('[fatal] exception non interceptée :', err); shutdown('uncaughtException'); });
