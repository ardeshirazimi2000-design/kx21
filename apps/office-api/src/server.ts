import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { ensureBaseData } from './db/bootstrap.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import './integration/meetings.js';
import { startWorker } from './services/jobs.js';
import { startScheduler } from './services/scheduler.js';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(false);
  await ensureBaseData();
  const server = http.createServer(createApp());
  if (config.workerEnabled) startWorker();
  if (process.env.SCHEDULER_ENABLED !== 'false') startScheduler();
  server.listen(config.port, () => logger.info(`Office automation API listening on :${config.port}`));
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
