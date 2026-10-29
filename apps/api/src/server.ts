import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { demoPasswordAccounts } from './db/seed.js';
import { logger } from './lib/logger.js';
import { initRealtime } from './realtime.js';
import { startIntegrationWorker } from './services/integrations.js';
import { startScheduler } from './services/scheduler.js';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(false);
  if (config.isProd) {
    const demo = await demoPasswordAccounts();
    if (demo.length) logger.warn({ accounts: demo }, 'accounts still use the public demo password: change their passwords or deactivate them');
  }
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  if (process.env.SCHEDULER_ENABLED !== 'false') startScheduler();
  if (config.integrationWorkerEnabled) startIntegrationWorker();
  server.listen(config.port, () => logger.info(`API listening on :${config.port}`));
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
