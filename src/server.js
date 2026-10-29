import cluster from 'node:cluster';
import { createApp, loadConfig } from './app.js';
import { DEMO_ACCOUNTS } from './seed.js';

// Multi-core mode: the primary process prepares the database once (migrations, seed data), then
// starts one worker per core; workers share the port and the SQLite file, and only worker 1 runs
// the background jobs (reminders, payment and support sweeps, clean-ups).
const { workers, dbPath } = loadConfig();
const multi = workers > 1 && dbPath !== ':memory:';

if (multi && cluster.isPrimary) {
  createApp({ disableSweeper: true }).db.close();
  let stopping = false;
  const start = (id) => cluster.fork({ WORKER_ID: String(id) }).on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[cluster] worker ${id} exited (${signal ?? code}); restarting`);
    setTimeout(() => start(id), 1000);
  });
  for (let i = 1; i <= workers; i++) start(i);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
      setTimeout(() => process.exit(0), 5000).unref();
      cluster.on('exit', () => { if (!Object.keys(cluster.workers).length) process.exit(0); });
    });
  }
} else {
  const workerId = multi ? Number(process.env.WORKER_ID) : 1;
  const app = createApp(multi ? { bootstrap: false, ...(workerId === 1 ? {} : { disableSweeper: true }) } : {});
  const { port, host, devMode, llmBaseUrl } = app.config;

  app.server.listen(port, host, () => {
    if (workerId !== 1) return;
    console.log(`\n🩺 Telehealth MVP running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${multi ? ` (${workers} processes)` : ''}`);
    console.log(`   mode: ${devMode ? 'development (OTP codes shown in UI/console)' : 'production'}`);
    console.log(`   assistant text generation: ${llmBaseUrl ? `self-hosted LLM at ${llmBaseUrl}` : 'grounded templates (set LLM_BASE_URL for vLLM)'}`);
    if (devMode) {
      console.log('   demo accounts: any new mobile number = patient |',
        `doctor ${DEMO_ACCOUNTS.doctors[0].phone} | operator ${DEMO_ACCOUNTS.operator.phone} | admin ${DEMO_ACCOUNTS.admin.phone}\n`);
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      app.server.close();
      app.db.close();
      process.exit(0);
    });
  }
}
