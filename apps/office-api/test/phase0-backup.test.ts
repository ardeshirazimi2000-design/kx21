// Regression test for the production readiness review, phase 0, R4: a backup made by deploy/backup.sh is really
// restorable. Builds a source installation (both databases, both file stores, the config files with the keys) in
// scratch databases and folders, backs it up, restores it into other empty databases and folders, and verifies the
// result. Nothing outside the kx_bk_* test databases and a temporary folder is touched.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');
const tsx = path.join(repo, 'node_modules/.bin/tsx');
const base = new URL(process.env.DATABASE_URL!);
const urlOf = (db: string) => Object.assign(new URL(base), { pathname: `/${db}` }).toString();
const DBS = { meetings: 'kx_bk_meetings', office: 'kx_bk_office', meetingsRestored: 'kx_bk_meetings_restored', officeRestored: 'kx_bk_office_restored' };
const KEY = crypto.randomBytes(32).toString('hex');
const JWT = crypto.randomBytes(32).toString('hex');
const MEETINGS_JWT = crypto.randomBytes(32).toString('hex');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kx21-backup-test-'));
const dirs = {
  uploads: path.join(tmp, 'src/uploads'),
  storage: path.join(tmp, 'src/office-storage'),
  uploadsRestored: path.join(tmp, 'restored/uploads'),
  storageRestored: path.join(tmp, 'restored/office-storage'),
  backups: path.join(tmp, 'backups'),
  config: path.join(tmp, 'restored/config'),
};
const files = {
  env: path.join(tmp, 'kx21.env'),
  officeEnv: path.join(tmp, 'kx21-office.env'),
  pass: path.join(tmp, 'backup.pass'),
};

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
let pool: pg.Pool;
let backupFile = '';
const source: Record<string, any> = {};

/** Environment of the backup/restore scripts: the scratch "server", libpq access to the test PostgreSQL. */
function scriptEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH!,
    HOME: tmp,
    MODE: 'systemd',
    PG_RUN: '',
    PGHOST: base.hostname,
    PGPORT: base.port || '5432',
    PGUSER: decodeURIComponent(base.username),
    PGPASSWORD: decodeURIComponent(base.password),
    ENV_FILE: files.env,
    OFFICE_ENV_FILE: files.officeEnv,
    BACKUP_DIR: dirs.backups,
    BACKUP_PASSPHRASE_FILE: files.pass,
    ...extra,
  };
}
const run = (script: string, env: Record<string, string>, args: string[] = []) =>
  spawnSync('bash', [path.join(repo, 'deploy', script), ...args], { env, encoding: 'utf8', timeout: 180_000 });
const restoreEnv = (extra: Record<string, string> = {}) =>
  scriptEnv({
    CONFIRM_RESTORE: 'yes',
    RESTORE_MEETINGS_DB: DBS.meetingsRestored,
    RESTORE_OFFICE_DB: DBS.officeRestored,
    RESTORE_UPLOAD_DIR: dirs.uploadsRestored,
    RESTORE_STORAGE_DIR: dirs.storageRestored,
    RESTORE_CONFIG_OUT: dirs.config,
    ...extra,
  });

async function counts(db: string) {
  const c = new pg.Client({ connectionString: urlOf(db) });
  await c.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of db.includes('office') ? ['users', 'letters', 'letter_attachments', 'signatures', 'audit_logs', 'document_versions'] : ['users', 'documents', 'meetings']) {
      out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    return out;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin.connect();
  for (const db of Object.values(DBS)) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DBS.meetings}`);
  await admin.query(`CREATE DATABASE ${DBS.office}`);
  for (const d of [dirs.uploads, dirs.storage, dirs.backups]) mkdirSync(d, { recursive: true });
  writeFileSync(files.pass, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  writeFileSync(files.env, `DATABASE_URL=${urlOf(DBS.meetings)}\nJWT_SECRET=${MEETINGS_JWT}\nUPLOAD_DIR=${dirs.uploads}\n`, { mode: 0o600 });
  writeFileSync(
    files.officeEnv,
    `DATABASE_URL=${urlOf(DBS.office)}\nJWT_SECRET=${JWT}\nDATA_ENCRYPTION_KEY=${KEY}\nSTORAGE_DIR=${dirs.storage}\n`,
    { mode: 0o600 },
  );

  // Meetings system: schema and demo data, plus one stored document.
  execFileSync(tsx, ['src/db/seed.ts'], {
    cwd: path.join(repo, 'apps/api'),
    env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: urlOf(DBS.meetings), JWT_SECRET: MEETINGS_JWT, UPLOAD_DIR: dirs.uploads },
    stdio: 'ignore',
  });
  const m = new pg.Client({ connectionString: urlOf(DBS.meetings) });
  await m.connect();
  const chamber = (await m.query('SELECT id FROM chambers LIMIT 1')).rows[0].id;
  const content = Buffer.from('%PDF-1.4 meeting minutes for the backup test');
  mkdirSync(path.join(dirs.uploads, chamber), { recursive: true });
  writeFileSync(path.join(dirs.uploads, chamber, 'minutes-1'), content);
  await m.query(`INSERT INTO documents (chamber_id, file_name, mime_type, size_bytes, storage_key, sha256) VALUES ($1,'minutes.pdf','application/pdf',$2,$3,$4)`, [
    chamber, content.length, `${chamber}/minutes-1`, crypto.createHash('sha256').update(content).digest('hex'),
  ]);
  await m.end();

  // Office automation, running against the source database with the source key and storage.
  Object.assign(process.env, { DATABASE_URL: urlOf(DBS.office), STORAGE_DIR: dirs.storage, DATA_ENCRYPTION_KEY: KEY, JWT_SECRET: JWT });
  const { seed, SEED_PASSWORD } = await import('../src/db/seed.js');
  const { createApp } = await import('../src/app.js');
  pool = (await import('../src/db/pool.js')).pool;
  await seed();
  const app = createApp();
  const token = (await request(app).post('/api/auth/login').send({ identifier: 'president', password: SEED_PASSWORD })).body.accessToken;
  const as = (r: request.Test) => r.set('authorization', `Bearer ${token}`);
  const letter = (await as(request(app).post('/api/letters')).send({ kind: 'internal', subject: 'نامه آزمون پشتیبان', body: 'متن آزمون', confidentiality: 1, register: true })).body;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF backup-test');
  const att = await as(request(app).post(`/api/letters/${letter.id}/attachments`)).attach('file', pdf, 'attachment.pdf');
  expect(att.status).toBe(201);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('specimen')]);
  const me = (await as(request(app).get('/api/auth/me'))).body;
  expect((await as(request(app).post(`/api/users/${me.id}/signature`)).attach('file', png, 'sign.png')).status).toBe(204);
  expect((await as(request(app).post(`/api/letters/${letter.id}/sign`)).send({})).status).toBe(201);
  Object.assign(source, { letter, attachment: att.body, pdf });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  for (const db of Object.values(DBS)) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('R4: backup and restore', () => {
  it('the backup is one encrypted file with a checksum; it contains no readable text or key', () => {
    const r = run('backup.sh', scriptEnv());
    expect(r.status, r.stderr).toBe(0);
    backupFile = r.stdout.trim().split('\n').pop()!;
    expect(readdirSync(dirs.backups).sort()).toEqual([path.basename(backupFile), `${path.basename(backupFile)}.sha256`]);
    const raw = readFileSync(backupFile);
    expect(raw.subarray(0, 8).toString()).toBe('Salted__');
    expect(raw.includes(Buffer.from(KEY))).toBe(false);
    expect(raw.includes(Buffer.from('DATABASE_URL'))).toBe(false);
  });

  it('refuses without confirmation, with a wrong passphrase, and onto non-empty targets', () => {
    expect(run('restore.sh', restoreEnv({ CONFIRM_RESTORE: '' }), [backupFile]).status).not.toBe(0);
    const wrong = path.join(tmp, 'wrong.pass');
    writeFileSync(wrong, 'not-the-passphrase', { mode: 0o600 });
    const w = run('restore.sh', restoreEnv({ BACKUP_PASSPHRASE_FILE: wrong }), [backupFile]);
    expect(w.status).not.toBe(0);
    expect(w.stderr).toContain('cannot decrypt');
    // The live (source) databases are not empty: restoring onto them is refused and nothing changes.
    const live = run('restore.sh', restoreEnv({ RESTORE_MEETINGS_DB: DBS.meetings, RESTORE_OFFICE_DB: DBS.office }), [backupFile]);
    expect(live.status).not.toBe(0);
    expect(live.stderr).toContain('not empty');
  });

  it('refuses when the target server has another encryption key', () => {
    const other = path.join(tmp, 'other-office.env');
    writeFileSync(other, `DATA_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    const r = run('restore.sh', restoreEnv({ OFFICE_ENV_FILE: other }), [backupFile]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('DATA_ENCRYPTION_KEY');
    expect(r.stderr + r.stdout).not.toContain(KEY);
  });

  it('restores onto empty databases and folders, and the verification passes', async () => {
    const r = run('restore.sh', restoreEnv(), [backupFile]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('restore complete');
    expect(r.stderr).toContain('meeting documents: 1 verified');
    expect(r.stderr).toContain('verifying office automation');
    expect(r.stdout).toContain('"failures": []');
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(await counts(DBS.officeRestored)).toEqual(await counts(DBS.office));
    expect(await counts(DBS.meetingsRestored)).toEqual(await counts(DBS.meetings));
    expect((await counts(DBS.officeRestored)).letter_attachments).toBeGreaterThan(0);
    expect((await counts(DBS.officeRestored)).signatures).toBeGreaterThan(0);
    expect(readFileSync(path.join(dirs.config, 'kx21-office.env'), 'utf8')).toContain(`DATA_ENCRYPTION_KEY=${KEY}`);
  });

  it('the restored installation serves the attachment and the signature verifies', () => {
    const out = execFileSync(tsx, ['src/db/verify-backup.ts'], {
      cwd: path.join(repo, 'apps/office-api'),
      env: { PATH: process.env.PATH, DATABASE_URL: urlOf(DBS.officeRestored), STORAGE_DIR: dirs.storageRestored, DATA_ENCRYPTION_KEY: KEY, JWT_SECRET: JWT },
      encoding: 'utf8',
    });
    const report = JSON.parse(out);
    expect(report.failures).toEqual([]);
    expect(report.counts.files_hashed).toBeGreaterThan(0);
    expect(report.counts.signatures_intact).toBe(report.counts.signatures);
    expect(report.counts.signing_keys).toBeGreaterThan(0);
  });

  it('the verification catches a damaged restored file and a wrong key', () => {
    const attPath = path.join(dirs.storageRestored, execFileSync('psql', ['-tAc', `SELECT storage_key FROM letter_attachments LIMIT 1`, urlOf(DBS.officeRestored)], { encoding: 'utf8' }).trim());
    const original = readFileSync(attPath);
    writeFileSync(attPath, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original[original.length - 1] ^ 1])]));
    const env = { PATH: process.env.PATH!, DATABASE_URL: urlOf(DBS.officeRestored), STORAGE_DIR: dirs.storageRestored, DATA_ENCRYPTION_KEY: KEY, JWT_SECRET: JWT };
    const damaged = spawnSync(tsx, ['src/db/verify-backup.ts'], { cwd: path.join(repo, 'apps/office-api'), env, encoding: 'utf8' });
    expect(damaged.status).toBe(1);
    expect(damaged.stdout).toContain('not decryptable');
    writeFileSync(attPath, original);
    const wrongKey = spawnSync(tsx, ['src/db/verify-backup.ts'], {
      cwd: path.join(repo, 'apps/office-api'),
      env: { ...env, DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') },
      encoding: 'utf8',
    });
    expect(wrongKey.status).toBe(1);
  });

  it('replaces non-empty targets only with RESTORE_REPLACE=1, after a safety backup', async () => {
    const safety = path.join(tmp, 'safety');
    const r = run('restore.sh', restoreEnv({ RESTORE_REPLACE: '1', SAFETY_BACKUP_DIR: safety, RESTORE_CONFIG_OUT: path.join(tmp, 'restored/config2') }), [backupFile]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('safety backup');
    expect(readdirSync(safety).filter((f) => f.endsWith('.tar.enc'))).toHaveLength(1);
    expect(await counts(DBS.officeRestored)).toEqual(await counts(DBS.office));
  });

  it('keeps only the newest BACKUP_KEEP backups', () => {
    for (let i = 0; i < 2; i++) {
      spawnSync('sleep', ['1.1']);
      expect(run('backup.sh', scriptEnv({ BACKUP_KEEP: '2' })).status).toBe(0);
    }
    expect(readdirSync(dirs.backups).filter((f) => f.endsWith('.tar.enc'))).toHaveLength(2);
  });
});
