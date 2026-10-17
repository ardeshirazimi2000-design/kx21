import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.OFFICE_TEST_DATABASE_URL ?? 'postgres://kx:kx@localhost:5432/kx_office_test',
      STORAGE_DIR: './.test-storage',
      TZ: 'Asia/Tehran',
      PUBLIC_URL: 'http://office.test',
    },
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
