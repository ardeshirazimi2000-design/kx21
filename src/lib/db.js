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

-- Doctor–platform agreement: the doctor signs after the credentials are approved, then the platform.
CREATE TABLE IF NOT EXISTS doctor_contracts (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  doctor_id           TEXT NOT NULL REFERENCES doctors(id),
  version             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending_platform','active','terminated')),
  content             TEXT NOT NULL,
  doctor_signature    TEXT NOT NULL,
  doctor_signed_at    TEXT NOT NULL,
  doctor_sign_ip      TEXT,
  platform_signature  TEXT,
  platform_signed_at  TEXT,
  platform_signer_id  TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_doctor ON doctor_contracts (doctor_id, created_at);

-- Messages rejected as inappropriate (insults, obscene words, spam, meaningless text).
CREATE TABLE IF NOT EXISTS moderation_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  context     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  excerpt     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_user ON moderation_events (user_id, created_at);

-- Support: one conversation per request; the support assistant answers first, a support agent
-- (permission support.handle) takes over when asked or when the assistant cannot help.
CREATE TABLE IF NOT EXISTS support_tickets (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','waiting','answered','closed')),
  topic        TEXT,
  assigned_to  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  escalated_at TEXT,
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_tickets (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets (tenant_id, status, updated_at);
CREATE TABLE IF NOT EXISTS support_messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES support_tickets(id),
  sender      TEXT NOT NULL CHECK (sender IN ('user','bot','staff','system')),
  staff_id    TEXT REFERENCES users(id),
  body        TEXT NOT NULL,
  actions     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_msgs ON support_messages (ticket_id, created_at);

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

-- uploaded files (object storage stand-in); content is envelope-encrypted on disk
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL CHECK (purpose IN ('doctor_photo','license_card','medical_record')),
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- patient → doctor medical documents (lab results, imaging, reports …)
CREATE TABLE IF NOT EXISTS medical_records (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  appointment_id  TEXT REFERENCES appointments(id),
  category        TEXT NOT NULL CHECK (category IN ('lab','imaging','report','prescription','other')),
  title           TEXT NOT NULL,
  note            TEXT,
  lab_rows        TEXT NOT NULL DEFAULT '[]',
  file_ids        TEXT NOT NULL DEFAULT '[]',
  ai_review       TEXT,
  doctor_opinion  TEXT,
  opinion_by      TEXT REFERENCES doctors(id),
  opinion_at      TEXT,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON medical_records (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_appt ON medical_records (appointment_id);

-- tenant settings (tariffs …)
CREATE TABLE IF NOT EXISTS settings (
  tenant_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  purpose      TEXT NOT NULL CHECK (purpose IN ('appointment','triage')),
  ref_id       TEXT,
  amount       INTEGER NOT NULL,          -- Rial
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','paid','failed','expired','refund_required','refunded')),
  gateway      TEXT NOT NULL,
  authority    TEXT,
  ref_number   TEXT,
  card_pan     TEXT,
  description  TEXT,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL,
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_authority ON payments (authority) WHERE authority IS NOT NULL;

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

-- visit summary (SOAP) — auto-drafted, edited and finalized by the physician
CREATE TABLE IF NOT EXISTS visit_summaries (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  consultation_id  TEXT NOT NULL UNIQUE REFERENCES consultations(id),
  appointment_id   TEXT NOT NULL,
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  doctor_id        TEXT NOT NULL REFERENCES doctors(id),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  complaint        TEXT,
  subjective       TEXT,
  objective        TEXT,
  assessment       TEXT,                 -- physician only; never generated
  plan             TEXT,
  advice           TEXT,
  follow_up        TEXT,
  patient_summary  TEXT,
  share_assessment INTEGER NOT NULL DEFAULT 0,
  edited_fields    TEXT NOT NULL DEFAULT '[]',
  generator        TEXT,
  sources          TEXT,
  generated_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  finalized_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_visit_summaries_patient ON visit_summaries (patient_id, finalized_at DESC);

-- chest X-ray pattern flags (research aid for the physician) + physician feedback for the pilot
CREATE TABLE IF NOT EXISTS cxr_analyses (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  record_id        TEXT NOT NULL REFERENCES medical_records(id),
  file_id          TEXT NOT NULL REFERENCES files(id),
  doctor_id        TEXT NOT NULL REFERENCES doctors(id),
  model            TEXT NOT NULL,
  findings         TEXT NOT NULL,
  quality          TEXT NOT NULL DEFAULT '[]',
  overlay_files    TEXT NOT NULL DEFAULT '{}',
  feedback         TEXT,
  feedback_note    TEXT,
  feedback_at      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cxr_record ON cxr_analyses (record_id, created_at);

-- each physician's own prescription templates ("my usual prescriptions")
CREATE TABLE IF NOT EXISTS rx_templates (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  doctor_id       TEXT NOT NULL REFERENCES doctors(id),
  name            TEXT NOT NULL,
  diagnosis_code  TEXT,
  drugs           TEXT NOT NULL,
  notes           TEXT,
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rx_templates_doctor ON rx_templates (doctor_id, use_count DESC);

-- cache of the external drug directory (only drug names are sent out)
CREATE TABLE IF NOT EXISTS drug_api_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- national drug coding (eRx-IRC) uploaded by the admin; versions kept for rollback
CREATE TABLE IF NOT EXISTS drug_catalogs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('staged','active','archived')),
  summary       TEXT NOT NULL,
  issues        TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  activated_at  TEXT
);
CREATE TABLE IF NOT EXISTS erx_items (
  catalog_id    TEXT NOT NULL REFERENCES drug_catalogs(id),
  erx_code      TEXT NOT NULL,
  title         TEXT NOT NULL,
  generic_code  TEXT,
  generic_name  TEXT NOT NULL,
  brand         TEXT,
  form          TEXT,
  action        TEXT,
  packs         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (catalog_id, erx_code)
);
CREATE INDEX IF NOT EXISTS idx_erx_generic ON erx_items (catalog_id, generic_name);
CREATE TABLE IF NOT EXISTS erx_deleted (
  catalog_id    TEXT NOT NULL,
  erx_code      TEXT NOT NULL,
  title         TEXT,
  replacement   TEXT,
  PRIMARY KEY (catalog_id, erx_code)
);

-- staff roles = named permission sets (see modules/access.js)
CREATE TABLE IF NOT EXISTS staff_roles (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  permissions  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

-- every login attempt (success and failure)
CREATE TABLE IF NOT EXISTS login_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT,
  phone       TEXT,
  success     INTEGER NOT NULL,
  method      TEXT NOT NULL,
  reason      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_tenant ON login_events (tenant_id, at DESC);

-- payouts (settlements) to doctors
CREATE TABLE IF NOT EXISTS doctor_payouts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  doctor_id   TEXT NOT NULL REFERENCES doctors(id),
  amount      INTEGER NOT NULL,           -- Rial
  paid_at     TEXT NOT NULL,
  reference   TEXT,
  sheba       TEXT,
  note        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_doctor ON doctor_payouts (doctor_id, paid_at DESC);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return wrap(db);
}

// Additive migrations for databases created by earlier versions (columns only; data kept).
const COLUMNS = {
  users: [
    ['national_id_enc', 'BLOB'], ['national_id_hash', 'BLOB'],
    ['identity_verified_at', 'TEXT'], ['identity_source', 'TEXT'],
    ['registry_verified_at', 'TEXT'], ['birth_date', 'TEXT'], // civil-registry (PersonInfo) check: name is locked after it
    ['staff_role_id', 'TEXT'], ['disabled_at', 'TEXT'], ['disabled_reason', 'TEXT'], // access control
    ['terms_version', 'TEXT'], ['terms_accepted_at', 'TEXT'], ['terms_accepted_ip', 'TEXT'], // registration agreement
  ],
  doctors: [
    ['status', "TEXT NOT NULL DEFAULT 'approved'"], // draft | pending_review | approved | rejected | suspended
    ['photo_file_id', 'TEXT'], ['license_card_file_id', 'TEXT'],
    ['education', 'TEXT'], ['experience_years', 'INTEGER'],
    ['review_reason', 'TEXT'], ['reviewed_by', 'TEXT'], ['reviewed_at', 'TEXT'], ['submitted_at', 'TEXT'],
    ['sheba', 'TEXT'], // bank account (IBAN) for payouts
    ['contract_required', 'INTEGER'], ['contract_signed_at', 'TEXT'], // cooperation agreement (doctors approved from 1405/07)
  ],
  appointments: [['payment_due_at', 'TEXT'], ['cancel_reason', 'TEXT'], ['cancelled_by', 'TEXT'], ['reminded_60_at', 'TEXT'], ['reminded_room_at', 'TEXT'],
    ['queue_next_at', 'TEXT'], ['queue_delay_notified', 'INTEGER'], // live queue notifications
    // Money of a cancelled paid visit: forfeit (patient cancelled late) | credit (cancelled by the clinic
    // side; the patient picks a new time or a refund) | credit_used | credit_refund | refund.
    ['refund_policy', 'TEXT']],
  consultations: [['doctor_joined_at', 'TEXT']],
  // Satisfaction with the support team's answers (1–5) and who closed the conversation.
  support_tickets: [['rating', 'INTEGER'], ['rating_comment', 'TEXT'], ['rated_at', 'TEXT'], ['closed_by', 'TEXT']],
  // blocked_at: a free slot switched off by the doctor (not offered); removed_at: deleted by the
  // doctor but kept because past (e.g. cancelled) visits refer to it.
  slots: [['blocked_at', 'TEXT'], ['removed_at', 'TEXT']],
  otp_codes: [['payload', 'TEXT']], // pending registration (role, verified national id) until OTP is confirmed
  prescriptions: [['diagnoses', 'TEXT'], ['safety', 'TEXT']],
  // Split of each payment, fixed at creation: commission percent, platform share, doctor share.
  payments: [['doctor_id', 'TEXT'], ['commission_percent', 'REAL'], ['platform_amount', 'INTEGER'], ['doctor_amount', 'INTEGER']], // ICD-10 codes; safety-check result + override reason at signing
};
function migrate(db) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_nid ON users (tenant_id, national_id_hash)`);
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
