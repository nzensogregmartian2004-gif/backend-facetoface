import 'dotenv/config';
import { z } from 'zod';

const flag = (def: 'true' | 'false') =>
  z.enum(['true', 'false']).default(def).transform((v) => v === 'true');

// Variable facultative : une chaîne vide (ex. « CDN_URL= » dans .env) équivaut à « non définie ».
const opt = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit contenir au moins 32 caractères'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  // Pont temporaire : l'âge minimum deviendra un paramètre administrable à l'étape 17.
  MIN_REGISTRATION_AGE: z.coerce.number().int().min(0).default(13),
  REQUIRE_EMAIL_VERIFICATION: flag('false'),
  MAX_FAILED_LOGINS: z.coerce.number().int().min(1).default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  CODE_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
  CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: flag('false'),
  RATE_LIMIT_ENABLED: flag('true'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  UPLOAD_DIR: z.string().default('uploads'),
  AVATAR_MAX_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),
  // ── Étape 3 : stockage objet (jamais de vidéo en base ni sur le disque de l'API) ──
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'), // `memory` : tests uniquement (refusé en production)
  STORAGE_ENDPOINT: opt, // vide = AWS S3 ; sinon R2, MinIO, etc.
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_FORCE_PATH_STYLE: opt, // « true »/« false » ; défaut : true si STORAGE_ENDPOINT est défini
  STORAGE_ACCESS_KEY: opt,
  STORAGE_SECRET_KEY: opt,
  STORAGE_BUCKET: opt,
  CDN_URL: opt, // si défini, les lectures passent par le CDN (étape 21 : URL signées/transcodage)
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().min(60).default(7200),
  // Médias privés (messagerie) : URL TOUJOURS signées, même si CDN_URL est défini (le CDN public n'est jamais utilisé pour eux).
  PRIVATE_MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).default(3600),
  VIDEO_MAX_BYTES: z.coerce.number().int().min(1).max(2_147_483_647).default(1_073_741_824),
  SHORT_MAX_BYTES: z.coerce.number().int().min(1).max(2_147_483_647).default(157_286_400),
  THUMBNAIL_MAX_BYTES: z.coerce.number().int().min(1).default(2 * 1024 * 1024),
  // Pont temporaire : deviendront des paramètres administrables (étape 17).
  SHORT_MAX_SECONDS: z.coerce.number().int().min(1).default(60),
  DOWNLOADS_ENABLED: flag('true'),
  VIEW_DEDUP_HOURS: z.coerce.number().int().min(1).default(24),
  FEED_CANDIDATES: z.coerce.number().int().min(20).max(1000).default(300),
  SHARE_BASE_URL: opt, // base des liens de partage ; défaut : PUBLIC_BASE_URL
  // ── Étape 5 : messagerie et messages payants. Ponts temporaires → paramètres administrables (étape 17). ──
  MESSAGE_MEDIA_ENABLED: flag('true'),
  MESSAGE_IMAGE_MAX_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024),
  MESSAGE_VIDEO_MAX_BYTES: z.coerce.number().int().min(1).default(100 * 1024 * 1024),
  PAID_MESSAGE_MIN_FCFA: z.coerce.number().int().min(1).default(100),
  PAID_MESSAGE_MAX_FCFA: z.coerce.number().int().min(1).default(200_000),
  // Commission plateforme en points de base (2000 = 20 %, cahier des charges §26). Entier : aucun calcul en virgule flottante.
  PAID_MESSAGE_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),
  // `none` : paiements non configurés (503). `memory` : tests uniquement (refusé en production). `mypvit` : Mobile Money (Airtel Money, Moov Money) via MyPVit.
  // Les paiements MyPVit sont ASYNCHRONES (le client valide sur son téléphone, puis MyPVit appelle notre webhook). Portefeuille, retraits, remboursements : étape 13.
  PAYMENT_DRIVER: z.enum(['none', 'memory', 'mypvit']).default('none'),
  /** Jeton secret placé dans l'URL des webhooks (MyPVit ne signe pas ses appels) : /api/webhooks/mypvit/callback/<jeton>. Au moins 24 caractères. */
  PAYMENT_WEBHOOK_SECRET: opt,
  /** Qui supporte les frais de l'opérateur : `CUSTOMER` (ajoutés au débit du client ; la plateforme reçoit le prix plein) ou `MERCHANT`. La commission se calcule toujours sur le prix. */
  PAYMENT_FEE_PAYER: z.enum(['CUSTOMER', 'MERCHANT']).default('CUSTOMER'),
  // Rapprochement des paiements restés PENDING (webhook perdu) : interrogation de l'état après X s ; sans réponse après Y s → REVIEW (vérification manuelle, jamais d'échec automatique).
  PAYMENT_STATUS_CHECK_AFTER_SECONDS: z.coerce.number().int().min(30).default(180),
  PAYMENT_REVIEW_AFTER_SECONDS: z.coerce.number().int().min(60).default(1800),
  PAYMENT_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  MYPVIT_BASE_URL: z.string().default('https://api.mypvit.pro'),
  MYPVIT_API_PASSWORD: opt,
  MYPVIT_URLCODE_RENEW_SECRET: opt,
  MYPVIT_URLCODE_REST: opt,
  MYPVIT_URLCODE_STATUS: opt, // facultatif : le format de l'API de statut n'est pas publié ; sans lui, pas de rapprochement automatique (REVIEW manuel)
  MYPVIT_CALLBACK_URL_CODE: opt, // code de l'URL de callback enregistrée dans l'espace MyPVit
  MYPVIT_RECEPTION_URL_CODE: opt, // code de l'URL de réception de la clé secrète (renew-secret)
  MYPVIT_ACCOUNT_AIRTEL: opt, // operationAccountCode du compte marchand Airtel Money
  MYPVIT_ACCOUNT_MOOV: opt, // operationAccountCode du compte marchand Moov Money
  MYPVIT_AGENT: z.string().default('FACE-TO-FACE'),
  MYPVIT_PRODUCT: z.string().default('FACETOFACE'),
  /** Adresses IP autorisées à appeler les webhooks (séparées par des virgules). Vide = pas de filtrage IP (le jeton de l'URL reste exigé). */
  MYPVIT_WEBHOOK_ALLOWED_IPS: z.string().default(''),
  // ── Étape 6 : appels audio/vidéo payants. Ponts temporaires → paramètres administrables et versionnés (étapes 17–18). ──
  /** Transport audio/vidéo : `none` (503, aucun paiement accepté), `memory` (tests uniquement, refusé en production), `livekit` (jetons d'accès LiveKit, sans dépendance). */
  CALL_PROVIDER: z.enum(['none', 'memory', 'livekit']).default('none'),
  LIVEKIT_URL: opt, // URL WebSocket du serveur LiveKit (wss://…), renvoyée au mobile
  LIVEKIT_API_KEY: opt,
  LIVEKIT_API_SECRET: opt,
  CALL_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),
  CALL_MIN_PRICE_FCFA: z.coerce.number().int().min(1).default(100), // prix par minute ou de la session
  CALL_MAX_PRICE_FCFA: z.coerce.number().int().min(1).default(100_000),
  CALL_MAX_TOTAL_FCFA: z.coerce.number().int().min(1).default(500_000), // plafond du montant prépayé d'un appel
  CALL_MAX_DURATION_MINUTES: z.coerce.number().int().min(1).default(120),
  CALL_RING_SECONDS: z.coerce.number().int().min(5).default(45), // sonnerie avant « appel manqué »
  CALL_MIN_BILLABLE_SECONDS: z.coerce.number().int().min(0).default(10), // en dessous : appel non facturé (coupure immédiate)
  CALL_PAYMENT_VALID_SECONDS: z.coerce.number().int().min(30).default(300), // un paiement confirmé plus tard ne fait plus sonner : remboursement dû
  CALL_DISPUTE_DAYS: z.coerce.number().int().min(1).default(7),
  CREATOR_SUBSCRIPTION_MIN_FCFA: z.coerce.number().int().min(1).default(500),
  CREATOR_SUBSCRIPTION_MAX_FCFA: z.coerce.number().int().min(1).default(100_000),
  CREATOR_SUBSCRIPTION_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),
  CUSTOM_VIDEO_MIN_FCFA: z.coerce.number().int().min(1).default(1_000),
  CUSTOM_VIDEO_MAX_FCFA: z.coerce.number().int().min(1).default(500_000),
  CUSTOM_VIDEO_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),
  CUSTOM_VIDEO_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).default(900),
  CUSTOM_VIDEO_MAX_DEADLINE_DAYS: z.coerce.number().int().min(1).default(30),
  // Étape 13 — portefeuille/retraits. Valeurs temporaires jusqu'au Centre de configuration (étapes 17–18).
  WALLET_MIN_WITHDRAWAL_AMOUNT: z.coerce.number().int().min(1).default(5000),
  WALLET_WITHDRAWAL_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  // Étape 8/14 — pont temporaire avant le module Administration complet.
  VIEW_MONETIZATION_ADMIN_USER_IDS: z.string().default(''),
  ADVERTISING_DEFAULT_FREQUENCY_CAP: z.coerce.number().int().min(1).max(100).default(3),
  ADVERTISING_DEFAULT_FREQUENCY_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  ADVERTISING_CREATOR_SHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(4000),
  // Étape 16 — Administration. Liste d'identifiants administrateurs séparés par des virgules.
  ADMIN_USER_IDS: z.string().default(''),
  // Étape 15 — Premium : pont temporaire avant administration/configuration complète.
  PREMIUM_DEFAULT_MONTHLY_PRICE: z.coerce.number().int().min(1).default(9500),
  PREMIUM_DEFAULT_ANNUAL_PRICE: z.coerce.number().int().min(1).default(114000),
  PREMIUM_DEFAULT_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  PREMIUM_ADMIN_USER_IDS: z.string().default(''),
  CALL_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(15),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Face to Face <no-reply@facetoface.app>'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Configuration invalide (voir ENV_VARIABLES.md) :\n${msg}`);
}
export const env = parsed.data;
if (env.NODE_ENV === 'production' && env.PAYMENT_DRIVER === 'memory') throw new Error('PAYMENT_DRIVER=memory est réservé aux tests (voir ENV_VARIABLES.md)');
if (env.PAYMENT_DRIVER === 'mypvit') {
  const missing = ['MYPVIT_API_PASSWORD', 'MYPVIT_URLCODE_RENEW_SECRET', 'MYPVIT_URLCODE_REST', 'MYPVIT_CALLBACK_URL_CODE', 'MYPVIT_RECEPTION_URL_CODE', 'PAYMENT_WEBHOOK_SECRET'].filter((k) => !env[k as keyof typeof env]);
  if (!env.MYPVIT_ACCOUNT_AIRTEL && !env.MYPVIT_ACCOUNT_MOOV) missing.push('MYPVIT_ACCOUNT_AIRTEL ou MYPVIT_ACCOUNT_MOOV');
  if (missing.length) throw new Error(`PAYMENT_DRIVER=mypvit : variables manquantes (voir ENV_VARIABLES.md) : ${missing.join(', ')}`);
}
if (env.NODE_ENV === 'production' && env.CALL_PROVIDER === 'memory') throw new Error('CALL_PROVIDER=memory est réservé aux tests (voir ENV_VARIABLES.md)');
if (env.CALL_PROVIDER === 'livekit') {
  const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].filter((k) => !env[k as keyof typeof env]);
  if (missing.length) throw new Error(`CALL_PROVIDER=livekit : variables manquantes (voir ENV_VARIABLES.md) : ${missing.join(', ')}`);
}
if (env.PAYMENT_WEBHOOK_SECRET && env.PAYMENT_WEBHOOK_SECRET.length < 24) throw new Error('PAYMENT_WEBHOOK_SECRET doit contenir au moins 24 caractères');
if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'memory') throw new Error('STORAGE_DRIVER=memory est réservé aux tests (voir ENV_VARIABLES.md)');
export const isProd = env.NODE_ENV === 'production';
if (isProd) {
  if (!env.CORS_ORIGINS.trim()) throw new Error('CORS_ORIGINS doit être configuré en production');
  if (!/^https:\/\//i.test(env.PUBLIC_BASE_URL)) throw new Error('PUBLIC_BASE_URL doit utiliser HTTPS en production');
  if (env.TRUST_PROXY && !env.CORS_ORIGINS.trim()) throw new Error('Configuration proxy invalide');
  if (env.PAYMENT_DRIVER === 'mypvit' && !env.MYPVIT_WEBHOOK_ALLOWED_IPS.trim()) {
    throw new Error('MYPVIT_WEBHOOK_ALLOWED_IPS doit être configuré en production avec PAYMENT_DRIVER=mypvit');
  }
  if (!env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY || !env.STORAGE_BUCKET) {
    throw new Error('STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY et STORAGE_BUCKET doivent être configurés en production');
  }
  if (!env.SMTP_HOST) {
    throw new Error('SMTP_HOST doit être configuré en production pour les e-mails de vérification et de récupération de compte');
  }
}

