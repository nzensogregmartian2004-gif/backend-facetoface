import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/config/db';
import { testOutbox } from '../src/utils/mailer';
import { objectStorage, type MemoryStorage } from '../src/utils/objectStorage';
import { callProvider, type MemoryCallProvider } from '../src/utils/callProvider';
import { payments, type MemoryPayments } from '../src/utils/payments';

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await prisma.$executeRawUnsafe('TRUNCATE "FraudEvent", "AdminAuditLog", "CreatorMonetizationEligibility", "ViewMonetizationSetting", "CreatorViewAllocation", "CreatorPool", "AdvertisingRevenue", "AdClick", "AdImpression", "AdvertisingCampaign", "AdvertisingSetting", "Call", "CreatorCallSettings", "Notification", "MessagePurchase", "Message", "ConversationMember", "Conversation", "Report", "Follow", "ContentView", "Comment", "Like", "VideoVariant", "Video", "Short", "Block", "OneTimeCode", "Session", "PremiumPayment", "PremiumSubscription", "PremiumPromotion", "PremiumSetting", "CreatorSubscriptionPayment", "CreatorSubscription", "CreatorSubscriptionPlan", "CustomVideoPayment", "CustomVideoRequest", "Withdrawal", "FinancialTransaction", "WalletLedgerEntry", "Wallet", "CreatorEarning", "LiveReaction", "LiveChatMessage", "LiveViewer", "Live", "AppConfig", "ExchangeRate", "User" RESTART IDENTITY CASCADE');
  testOutbox.length = 0;
  memStore.clear();
  memPay.clear();
  memCalls.clear();
}

export const validUser = (n = 1) => ({
  email: `user${n}@example.com`,
  username: `user_${n}`,
  password: 'Passw0rdOK',
  displayName: `Utilisateur ${n}`,
  birthDate: '1995-06-15',
});

export async function signUp(n = 1, overrides: Record<string, unknown> = {}) {
  const res = await api().post('/api/auth/register').send({ ...validUser(n), ...overrides });
  return res;
}

export async function signedIn(n = 1) {
  const res = await signUp(n);
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { user: res.body.user, tokens: res.body.tokens as { accessToken: string; refreshToken: string }, auth: { Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** Dernier code à 6 chiffres envoyé par e-mail (boîte d'envoi de test). */
export function lastCode(to: string): string {
  const mail = [...testOutbox].reverse().find((m) => m.to === to);
  const m = mail?.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`aucun code envoyé à ${to}`);
  return m[1];
}

// ── Étape 3 : contenu ────────────────────────────────────────────
/** Pilote de stockage de test : `put` simule l'envoi direct du mobile vers le stockage objet. */
export const memStore = objectStorage as MemoryStorage;
/** Pilote de paiement de test : `requests` liste les demandes de paiement ; `rejectNext()` / `uncertainNext()` / `notSentNext()` simulent un refus net / une réponse perdue / un prestataire injoignable ; `setStatus()` pilote le rapprochement. */
export const memPay = payments as MemoryPayments;
/** Transport d'appel de test : `grants` liste les jetons délivrés, `closed` les salles fermées. */
export const memCalls = callProvider as MemoryCallProvider;
export type Kind = 'VIDEO' | 'SHORT';
export const basePath = (k: Kind) => (k === 'SHORT' ? '/api/shorts' : '/api/videos');
export const bodyKey = (k: Kind) => (k === 'SHORT' ? 'short' : 'video');

export async function creatorSignedIn(n = 1) {
  const s = await signedIn(n);
  const r = await api().post('/api/users/me/creator/activate').set(s.auth).send({});
  if (r.status !== 200) throw new Error(`activation créateur impossible : ${JSON.stringify(r.body)}`);
  return s;
}

export async function createDraft(auth: { Authorization: string }, k: Kind = 'VIDEO', meta: Record<string, unknown> = {}) {
  const r = await api().post(basePath(k)).set(auth).send({ title: 'Mon contenu', category: 'music', ...meta });
  if (r.status !== 201) throw new Error(`création impossible : ${JSON.stringify(r.body)}`);
  return r.body[bodyKey(k)] as { id: string; [key: string]: any };
}

/** Brouillon + envoi simulé + confirmation (sans publication). */
export async function uploadedDraft(auth: { Authorization: string }, k: Kind = 'VIDEO', meta: Record<string, unknown> = {}, opts: { withThumbnail?: boolean } = {}) {
  const d = await createDraft(auth, k, meta);
  const up = await api().post(`${basePath(k)}/${d.id}/upload-url`).set(auth).send({ file: 'video', contentType: 'video/mp4', sizeBytes: 5_000_000 });
  if (up.status !== 200) throw new Error(`upload-url : ${JSON.stringify(up.body)}`);
  memStore.put(up.body.upload.key, 5_000_000, 'video/mp4');
  if (opts.withThumbnail) {
    const t = await api().post(`${basePath(k)}/${d.id}/upload-url`).set(auth).send({ file: 'thumbnail', contentType: 'image/png', sizeBytes: 20_000 });
    memStore.put(t.body.upload.key, 20_000, 'image/png');
  }
  const done = await api().post(`${basePath(k)}/${d.id}/complete-upload`).set(auth).send(k === 'SHORT' ? { durationSeconds: 30, width: 720, height: 1280 } : { durationSeconds: 600, width: 1280, height: 720 });
  if (done.status !== 200) throw new Error(`complete-upload : ${JSON.stringify(done.body)}`);
  return done.body[bodyKey(k)] as { id: string; [key: string]: any };
}

export async function publishedContent(auth: { Authorization: string }, k: Kind = 'VIDEO', meta: Record<string, unknown> = {}, opts: { withThumbnail?: boolean } = {}) {
  const d = await uploadedDraft(auth, k, meta, opts);
  const r = await api().post(`${basePath(k)}/${d.id}/publish`).set(auth).send({});
  if (r.status !== 200) throw new Error(`publish : ${JSON.stringify(r.body)}`);
  return r.body[bodyKey(k)] as { id: string; [key: string]: any };
}

export const WEBHOOK_TOKEN = 'test-webhook-secret-0123456789abcdef';
/** Simule l'appel de callback de MyPVit pour une référence marchand (par la VRAIE route webhook). */
export const settle = (reference: string, status = 'SUCCESS', extra: Record<string, unknown> = {}) =>
  api().post(`/api/webhooks/mypvit/callback/${WEBHOOK_TOKEN}`).send({ merchantReferenceId: reference, status, transactionId: `tx_${reference}`, code: 200, ...extra });
