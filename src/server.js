import { createApp } from './app.js';
import { DEMO_ACCOUNTS } from './seed.js';

const app = createApp();
const { port, host, devMode, llmBaseUrl } = app.config;

app.server.listen(port, host, () => {
  console.log(`\n🩺 Telehealth MVP running at http://localhost:${port}`);
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
