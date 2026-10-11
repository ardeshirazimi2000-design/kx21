/**
 * FDP_RIP.2: residual information — secrets that are no longer needed are removed, not just flagged.
 */
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export async function purgeResidualData(): Promise<void> {
  // Used or expired OTP challenges (code HMACs, pending profiles) are deleted after a day.
  await pool.query(`DELETE FROM auth_challenges WHERE (consumed_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '1 day'`);
  // Ended sessions keep their record for the audit view but lose their refresh-token hash.
  await pool.query(`UPDATE sessions SET refresh_hash = '' WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND refresh_hash <> ''`);
  // Revoked devices lose their secret.
  await pool.query(`UPDATE user_devices SET secret_hash = NULL WHERE revoked_at IS NOT NULL AND secret_hash IS NOT NULL`);
}

export function startMaintenance(): void {
  const run = () => purgeResidualData().catch((err) => logger.error({ err }, 'residual data purge failed'));
  void run();
  setInterval(run, 3600_000).unref();
}
