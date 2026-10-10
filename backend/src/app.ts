import { geoRouter } from './modules/geo/geo.routes';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { prisma } from './config/db';
import { mailerConfigured } from './utils/mailer';
import { objectStorageConfigured } from './utils/objectStorage';
import { payments } from './utils/payments';
import { callProvider } from './utils/callProvider';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { globalLimiter } from './middleware/rateLimit';
import { requireHttps } from './middleware/security';
import { authRouter } from './modules/auth/auth.routes';
import { callsRouter } from './modules/calls/calls.routes';
import { commentsRouter } from './modules/comments/comments.routes';
import { storiesRouter } from './modules/stories/stories.routes';
import { createContentRouter } from './modules/content/content.routes';
import { feedRouter } from './modules/feed/feed.routes';
import { messagesRouter } from './modules/messages/messages.routes';
import { groupsRouter } from './modules/messages/groups.routes';
import { groupCallsRouter } from './modules/groupCalls/groupCalls.routes';
import { disputesRouter } from './modules/admin/disputes.routes';
import { disputeResponseRouter } from './modules/disputes/disputeResponse.routes';
import { contentPurgeRouter } from './modules/admin/contentPurge';
import { adminCoinsRouter } from './modules/coins/coins.admin.routes';
import { certificationRouter } from './modules/certification/certification.routes';
import { audienceRouter } from './modules/audience/audience.routes';
import { adminConsoleRouter } from './modules/admin/admin.console.routes';
import { creatorRevenueRouter } from './modules/monetization/creatorRevenue.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { webhooksRouter } from './modules/payments/webhooks.routes';
import { moderationRouter } from './modules/moderation/moderation.routes';
import { liveRouter } from './modules/live/live.routes';
import { liveVideoRouter } from './modules/live/live.video.routes';
import { monetizationRouter } from './modules/monetization/monetization.routes';
import { searchRouter } from './modules/search/search.routes';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes';
import { customVideosRouter } from './modules/customVideos/customVideos.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { advertisingRouter } from './modules/advertising/advertising.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { configRouter } from './modules/config/config.routes';
import { premiumRouter } from './modules/premium/premium.routes';
import { coinsRouter } from './modules/coins/coins.routes';
import { usersRouter } from './modules/users/users.routes';
import { supportRouter, supportAdminRouter } from './modules/support/support.routes';
import { uploadRoot } from './utils/storage';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, referrerPolicy: { policy: 'no-referrer' }, hsts: env.NODE_ENV === 'production' ? undefined : false }));
  app.use(requireHttps);
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins }));
  app.use(globalLimiter);
  app.use(express.json({ limit: '100kb', strict: true }));

  if (env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
      next();
    });
  }

  app.use('/uploads', express.static(uploadRoot, { maxAge: '7d', index: false, dotfiles: 'ignore' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', environment: env.NODE_ENV }));
  app.get('/api/health/ready', async (_req, res) => {
    let database = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    const checks = { database, storage: objectStorageConfigured, smtp: mailerConfigured, payments: payments.name !== 'none', calls: callProvider.configured() };
    const ready = checks.database && checks.storage && checks.smtp;
    return res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/geo', geoRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/videos', createContentRouter('VIDEO'));
  app.use('/api/shorts', createContentRouter('SHORT'));
  app.use('/api/comments', commentsRouter);
  app.use('/api/stories', storiesRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/group-calls', groupCallsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/live', liveRouter);
  app.use('/api/live', liveVideoRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/moderation', moderationRouter);
  app.use('/api/monetization', monetizationRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/custom-videos', customVideosRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/advertising', advertisingRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin', adminConsoleRouter);
app.use('/api/admin/config', configRouter);
  app.use('/api/admin/disputes', disputesRouter);
  app.use('/api/disputes', disputeResponseRouter);
  app.use('/api/admin/content', contentPurgeRouter);
  app.use('/api/admin/support', supportAdminRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/admin/coins', adminCoinsRouter);
  app.use('/api/admin/certification', certificationRouter);
  app.use('/api/creator/audience', audienceRouter);
  app.use('/api/monetization', creatorRevenueRouter);
  app.use('/api/premium', premiumRouter);
  app.use('/api/coins', coinsRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
