import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://kx:kx@localhost:5432/kx_test',
      UPLOAD_DIR: './.test-uploads',
      TZ: 'Asia/Tehran',
      WEBINAR_URL: 'https://webinar.test',
      WEBINAR_APP_SECRET: 'test-webinar-secret',
      // Tests scheduling meetings "in 3 days" would fail on the days that fall on a Friday; holidays.test enables it.
      MEETING_HOLIDAY_CHECK: 'false',
    },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
