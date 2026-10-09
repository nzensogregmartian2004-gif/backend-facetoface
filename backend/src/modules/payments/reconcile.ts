import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { PAYMENT_OPERATORS, payments, type MobileOperator } from '../../utils/payments';
import { reconcileCallPayments } from '../calls/calls.settlement';
import { settlePurchase } from './settlement';
import { settleGroupAccess } from '../messages/groupAccess.service';

/**
 * Rapprochement des achats restés PENDING (webhook perdu ou en retard). Idempotent, sans verrou : chaque transition passe par
 * `settlePurchase` (updateMany gardé), donc deux instances ou un webhook concurrent ne se marchent pas dessus.
 *  - après PAYMENT_STATUS_CHECK_AFTER_SECONDS : on interroge le prestataire (SUCCESS → PAID, FAILED → FAILED) ;
 *  - sans réponse exploitable après PAYMENT_REVIEW_AFTER_SECONDS : REVIEW (vérification manuelle). JAMAIS d'échec automatique :
 *    un client peut avoir été débité, et un nouvel essai le débiterait deux fois.
 *  - les achats REVIEW « TIMEOUT » continuent d'être interrogés : si l'état se précise, ils se résolvent seuls.
 */
export async function reconcilePurchases(now = new Date()) {
  const checkBefore = new Date(now.getTime() - env.PAYMENT_STATUS_CHECK_AFTER_SECONDS * 1000);
  const reviewBefore = new Date(now.getTime() - env.PAYMENT_REVIEW_AFTER_SECONDS * 1000);
  const rows = await prisma.messagePurchase.findMany({
    where: { reference: { not: null }, initiatedAt: { lt: checkBefore }, OR: [{ status: 'PENDING' }, { status: 'REVIEW', reviewReason: 'TIMEOUT' }] },
    orderBy: { initiatedAt: 'asc' }, take: 50,
  });
  const out = { checked: 0, paid: 0, failed: 0, review: 0, unknown: 0 };
  for (const p of rows) {
    out.checked++;
    const op = PAYMENT_OPERATORS.find((o) => o === p.operator) as MobileOperator | undefined;
    let remote: Awaited<ReturnType<typeof payments.checkStatus>> = null;
    try { if (op) remote = await payments.checkStatus(p.reference!, op); } catch { remote = null; }
    if (remote === 'SUCCESS' || remote === 'FAILED') {
      const r = await settlePurchase(p.reference!, { status: remote });
      if (r === 'paid') out.paid++; else if (r === 'failed') out.failed++; else if (r === 'review') out.review++;
      continue;
    }
    out.unknown++;
    if (p.status === 'PENDING' && p.initiatedAt < reviewBefore) {
      const r = await prisma.messagePurchase.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'REVIEW', reviewReason: 'TIMEOUT' } });
      if (r.count === 1) { out.review++; console.error(`[paiement] aucune confirmation pour la réf ${p.reference} après ${env.PAYMENT_REVIEW_AFTER_SECONDS}s : vérification manuelle`); }
    }
  }
  return out;
}

/** Démarre le rapprochement périodique (un seul timer par processus, sans empêcher l'arrêt). Aucun effet avec le pilote `none`. */
/** Même règle que `reconcilePurchases`, pour les accès payants aux groupes (préfixe G). */
export async function reconcileGroupAccess(now = new Date()) {
  const checkBefore = new Date(now.getTime() - env.PAYMENT_STATUS_CHECK_AFTER_SECONDS * 1000);
  const reviewBefore = new Date(now.getTime() - env.PAYMENT_REVIEW_AFTER_SECONDS * 1000);
  const rows = await prisma.groupAccessPurchase.findMany({
    where: { reference: { not: null }, initiatedAt: { lt: checkBefore }, OR: [{ status: 'PENDING' }, { status: 'REVIEW', reviewReason: 'TIMEOUT' }] },
    orderBy: { initiatedAt: 'asc' }, take: 50,
  });
  const out = { checked: 0, paid: 0, failed: 0, review: 0, unknown: 0 };
  for (const p of rows) {
    out.checked++;
    const op = PAYMENT_OPERATORS.find((o) => o === p.operator) as MobileOperator | undefined;
    let remote: Awaited<ReturnType<typeof payments.checkStatus>> = null;
    try { if (op) remote = await payments.checkStatus(p.reference!, op); } catch { remote = null; }
    if (remote === 'SUCCESS' || remote === 'FAILED') {
      const r = await settleGroupAccess(p.reference!, { status: remote });
      if (r === 'paid') out.paid++; else if (r === 'failed') out.failed++; else if (r === 'review') out.review++;
      continue;
    }
    out.unknown++;
    if (p.status === 'PENDING' && p.initiatedAt < reviewBefore) {
      const r = await prisma.groupAccessPurchase.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'REVIEW', reviewReason: 'TIMEOUT' } });
      if (r.count === 1) { out.review++; console.error(`[groupes] aucune confirmation pour la réf ${p.reference} après ${env.PAYMENT_REVIEW_AFTER_SECONDS}s : vérification manuelle`); }
    }
  }
  return out;
}

export function startReconciler(): NodeJS.Timeout | null {
  if (env.PAYMENT_DRIVER === 'none') return null;
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { await reconcilePurchases(); await reconcileGroupAccess(); await reconcileCallPayments(); } catch (e) { console.error('[paiement] rapprochement en erreur', e); } finally { running = false; }
  }, env.PAYMENT_RECONCILE_INTERVAL_SECONDS * 1000);
  t.unref();
  return t;
}
