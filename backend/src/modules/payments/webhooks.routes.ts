import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { wrap } from '../../utils/async';
import { webhookLimiter } from '../../middleware/rateLimit';
import { notFound } from '../../utils/errors';
import { receiveSecretFromWebhook } from './mypvit.client';
import { settleReference } from './settlement';

/**
 * Webhooks MyPVit. MyPVit NE SIGNE PAS ses appels : on empile deux protections.
 *  1. un jeton secret dans l'URL (PAYMENT_WEBHOOK_SECRET), comparé en temps constant — à enregistrer tel quel chez MyPVit ;
 *  2. une liste d'adresses IP autorisées (MYPVIT_WEBHOOK_ALLOWED_IPS), recommandée en production (à demander au support MyPVit).
 * Sans PAYMENT_WEBHOOK_SECRET, les routes n'existent pas (404). Un webhook ne peut de toute façon QUE régler un achat déjà en attente,
 * pour une référence connue, avec un montant vérifié — il ne crée jamais d'argent de lui-même.
 */
export const webhooksRouter = Router();

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const allowedIps = () => env.MYPVIT_WEBHOOK_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);

function guard(req: Request, res: Response, next: NextFunction) {
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (!secret || !same(String(req.params.token ?? ''), secret)) return next(notFound()); // 404 : on ne révèle pas l'existence de la route
  const ips = allowedIps();
  if (ips.length && !ips.includes((req.ip ?? '').replace(/^::ffff:/, ''))) {
    console.error(`[webhook] appel refusé : IP non autorisée (${req.ip})`);
    return res.status(403).json({ error: { code: 'IP_NOT_ALLOWED', message: 'IP non autorisée' } });
  }
  next();
}

const callbackSchema = z.object({
  merchantReferenceId: z.string().min(1).max(64),
  status: z.string().min(1).max(32),
  amount: z.coerce.number().finite().optional(),
  transactionId: z.string().max(128).optional(),
  code: z.union([z.string(), z.number()]).optional(),
}).passthrough();

/** POST /api/webhooks/mypvit/callback/:token — résultat d'un paiement. Répond toujours par l'écho exigé par MyPVit (transactionId + responseCode). */
webhooksRouter.post('/mypvit/callback/:token', webhookLimiter, guard, wrap(async (req, res) => {
  const parsed = callbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Payload invalide' } });
  const b = parsed.data;
  const status = b.status.toUpperCase() === 'SUCCESS' ? 'SUCCESS' : 'FAILED'; // tout ce qui n'est pas un succès net est un échec : on ne crédite jamais sur une ambiguïté
  // En cas d'erreur de traitement, l'exception remonte (500) : le callback est idempotent, un renvoi par MyPVit est sans danger.
  const result = await settleReference(b.merchantReferenceId, { status, amount: b.amount, providerRef: b.transactionId, payload: b });
  if (result === 'unknown') console.warn(`[webhook] référence inconnue : ${b.merchantReferenceId}`);
  res.status(200).json({ transactionId: b.transactionId, responseCode: b.code });
}));

/** POST /api/webhooks/mypvit/secret/:token — réception asynchrone de la clé secrète après renew-secret. */
webhooksRouter.post('/mypvit/secret/:token', webhookLimiter, guard, wrap(async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const secret = body?.secret ?? body?.secretKey ?? body?.secret_key ?? body?.key;
  if (typeof secret === 'string' && secret) {
    const exp = Number(body?.expires_in ?? body?.expiresIn);
    const account = body?.operation_account_code ?? body?.operationAccountCode;
    receiveSecretFromWebhook(secret, Number.isFinite(exp) && exp > 0 ? exp : undefined, typeof account === 'string' ? account : null);
  } else console.warn('[webhook] clé secrète reçue sans champ reconnaissable');
  res.status(200).json({ responseCode: 200, message: 'Secret received' });
}));
