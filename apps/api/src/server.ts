import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { initRealtime } from './realtime.js';
import { startScheduler } from './services/scheduler.js';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(false);
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  if (process.env.SCHEDULER_ENABLED !== 'false') startScheduler();
  server.listen(config.port, () => logger.info(`API listening on :${config.port}`));
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
