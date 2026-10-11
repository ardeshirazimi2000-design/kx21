import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';

await migrate();
createApp().listen(config.PORT, () => {
  logger.info({ port: config.PORT, apiir: config.APIIR_MODE }, 'crisis management API listening');
});
