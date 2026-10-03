// Storage layer. SQLite (node:sqlite) stands in for PostgreSQL 16 in local/dev runs.
// The schema follows section 5 of the design doc: tenant_id on every table, soft delete,
// encrypted sensitive columns, a partial unique index for "one active booking per slot",
// and an append-only audit log (UPDATE/DELETE blocked by triggers instead of REVOKE).
// Messages (MongoDB in the doc) and chat session state (Redis) live in tables here too.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('patient','doctor','admin','operator')),
  phone        TEXT NOT NULL,
  email        TEXT,
  full_name    TEXT,
  mfa_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT,
  UNIQUE (tenant_id, phone)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  target      TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login','mfa')),
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_target ON otp_codes (tenant_id, target, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS patients (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id),
  national_id_enc     BLOB NOT NULL,
  national_id_hash    BLOB NOT NULL,
  dob                 TEXT NOT NULL,
  gender              TEXT,
  allergies           TEXT NOT NULL DEFAULT '[]',
  chronic_conditions  TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  deleted_at          TEXT,
  UNIQUE (tenant_id, national_id_hash)
);

CREATE TABLE IF NOT EXISTS doctors (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  user_id              TEXT NOT NULL UNIQUE REFERENCES users(id),
  specialty            TEXT NOT NULL,
  license_no           TEXT NOT NULL,
  bio                  TEXT,
  languages            TEXT NOT NULL DEFAULT '["fa"]',
  sign_public_pem      TEXT NOT NULL,
  sign_private_sealed  BLOB NOT NULL,
  deleted_at           TEXT,
  UNIQUE (tenant_id, license_no)
);

CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  doctor_id  TEXT NOT NULL REFERENCES doctors(id),
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (doctor_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_doctor_time ON slots (doctor_id, starts_at);

CREATE TABLE IF NOT EXISTS triage_results (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  patient_id             TEXT REFERENCES patients(id),
  user_id                TEXT NOT NULL REFERENCES users(id),
  symptoms               TEXT NOT NULL,
  urgency_level          TEXT NOT NULL CHECK (urgency_level IN ('self_care','routine','urgent','emergency')),
  recommended_specialty  TEXT,
  red_flags              TEXT NOT NULL DEFAULT '[]',
  rule_version           TEXT NOT NULL,
  model_version          TEXT,
  reviewed_by            TEXT REFERENCES doctors(id),
  reviewed_at            TEXT,
  review_note            TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_patient ON triage_results (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  patient_id        TEXT NOT NULL REFERENCES patients(id),
  doctor_id         TEXT NOT NULL REFERENCES doctors(id),
  slot_id           TEXT NOT NULL REFERENCES slots(id),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  channel           TEXT NOT NULL DEFAULT 'video' CHECK (channel IN ('video','audio','chat')),
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  booked_via        TEXT NOT NULL DEFAULT 'app' CHECK (booked_via IN ('app','ai_assistant','operator')),
  triage_result_id  TEXT REFERENCES triage_results(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
-- one active booking per slot
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_active_slot
  ON appointments (slot_id) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments (doctor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS consultations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  appointment_id  TEXT NOT NULL UNIQUE REFERENCES appointments(id),
  room_id         TEXT NOT NULL,
  channel         TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  recording_url   TEXT
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  consultation_id  TEXT NOT NULL REFERENCES consultations(id),
  doctor_id        TEXT NOT NULL REFERENCES doctors(id),
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  drugs            TEXT NOT NULL,
  notes            TEXT,
  idempotency_key  TEXT NOT NULL,
  signature        BLOB,                 -- NULL = draft, not valid
  issued_at        TEXT,
  created_at       TEXT NOT NULL,
  CHECK ((signature IS NULL) = (issued_at IS NULL)),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS consents (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  patient_id   TEXT NOT NULL REFERENCES patients(id),
  type         TEXT NOT NULL CHECK (type IN ('telehealth','recording','ai_history_access','ai_training')),
  version      TEXT NOT NULL,
  accepted_at  TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents (patient_id, type);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  mode        TEXT NOT NULL DEFAULT 'INFO_MODE',
  state       TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (user_id, updated_at DESC);

-- conversation store (MongoDB "Message" collection in the doc)
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  thread_id   TEXT NOT NULL,       -- chat session id or consultation id
  thread_kind TEXT NOT NULL CHECK (thread_kind IN ('ai','consultation')),
  sender_id   TEXT,
  sender_role TEXT NOT NULL,       -- patient | doctor | assistant | operator | system
  content     TEXT NOT NULL,
  ai_meta     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS escalations (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES chat_sessions(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('emergency','human_request','low_confidence','guardrail')),
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT,
  channel     TEXT NOT NULL CHECK (channel IN ('sms','email','push')),
  target      TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

-- transactional outbox for domain events (published to Kafka in production)
CREATE TABLE IF NOT EXISTS outbox_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  topic       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  trace_id    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  resource   TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  trace_id   TEXT,
  ts         TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    // Nested calls reuse the outer transaction via savepoints.
    tx(fn) {
      const sp = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const r = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    },
    close: () => db.close(),
  };
}

export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export const parseJson = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
export const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e?.message));
