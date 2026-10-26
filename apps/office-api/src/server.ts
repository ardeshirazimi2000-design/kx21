import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { DEMO_USERNAMES, demoPasswordAccounts, ensureBaseData } from './db/bootstrap.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import './integration/meetings.js';
import { startWorker } from './services/jobs.js';
import { startScheduler } from './services/scheduler.js';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(false);
  await ensureBaseData();
  if (config.isProd) {
    const demo = await demoPasswordAccounts(pool, DEMO_USERNAMES);
    if (demo.length) logger.warn({ accounts: demo }, 'accounts still use the public demo password: change their passwords or deactivate them');
    if (!config.publicHttps) logger.warn('PUBLIC_HTTPS is not set: sign-in is accepted over plain HTTP; set up HTTPS (docs/office/05-https.md)');
  }
  const server = http.createServer(createApp());
  if (config.workerEnabled) startWorker();
  if (process.env.SCHEDULER_ENABLED !== 'false') startScheduler();
  server.listen(config.port, config.host, () => logger.info(`Office automation API listening on ${config.host ?? ''}:${config.port}`));
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
