import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://kx:kx@localhost:5432/kx_test',
      UPLOAD_DIR: './.test-uploads',
      TZ: 'Asia/Tehran',
    },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
