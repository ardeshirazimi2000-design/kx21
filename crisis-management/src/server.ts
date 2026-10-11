import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { audit } from './lib/audit.js';
import { logger } from './lib/logger.js';
import { APP_VERSION } from './lib/version.js';
import { checkAuditCapacity } from './services/auditStorage.js';
import { startIntegrityMonitor } from './services/integrity.js';
import { startMaintenance } from './services/maintenance.js';

// FCS_TLSC_EXT.1: outbound TLS (api.ir) never below TLS 1.2; certificates and host names are always verified.
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';

/** FCS_TLSS_EXT.1: TLS 1.2 with the protection profile's ECDHE AES-GCM/CBC suites only. */
const PP_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA256', 'ECDHE-ECDSA-AES256-SHA384', 'ECDHE-RSA-AES128-SHA256', 'ECDHE-RSA-AES256-SHA384',
].join(':');

if (config.MIGRATE_ON_START) await migrate();
const app = createApp();
const server = config.TLS_CERT_FILE
  ? https.createServer(
      {
        cert: readFileSync(config.TLS_CERT_FILE),
        key: readFileSync(config.TLS_KEY_FILE),
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        ciphers: PP_CIPHERS,
        honorCipherOrder: true,
        ecdhCurve: 'P-256:P-384',
        // Mutual TLS: client certificates are requested and verified against the CA (and CRL); the console enforces them.
        ...(config.TLS_CLIENT_CA_FILE
          ? { requestCert: true, rejectUnauthorized: false, ca: readFileSync(config.TLS_CLIENT_CA_FILE), crl: config.TLS_CLIENT_CRL_FILE ? readFileSync(config.TLS_CLIENT_CRL_FILE) : undefined }
          : {}),
      },
      app,
    )
  : http.createServer(app);

server.listen(config.PORT, async () => {
  logger.info({ port: config.PORT, tls: !!config.TLS_CERT_FILE, apiir: config.APIIR_MODE }, 'crisis management API listening');
  // FAU_GEN.1.1: start of the audit function.
  await audit({ action: 'audit.start', details: { version: APP_VERSION, node: process.version, tls: !!config.TLS_CERT_FILE } });
  await checkAuditCapacity();
  startIntegrityMonitor();
  startMaintenance();
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  try {
    await audit({ action: 'audit.stop', details: { signal } });
  } finally {
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
