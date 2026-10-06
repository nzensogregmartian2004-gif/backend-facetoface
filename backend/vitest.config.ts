import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      PRISMA_CLIENT_ENGINE_TYPE: 'library',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
      BCRYPT_COST: '4',
      RATE_LIMIT_ENABLED: 'false',
      MIN_REGISTRATION_AGE: '13',
      PUBLIC_BASE_URL: 'http://localhost:4000',
      UPLOAD_DIR: '.test-uploads',
      STORAGE_DRIVER: 'memory',
      PAYMENT_DRIVER: 'memory',
      CALL_PROVIDER: 'memory',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
    },
  },
});
