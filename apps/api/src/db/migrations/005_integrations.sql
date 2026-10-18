-- Integration with external systems (office automation / اتوماسیون اداری, accounting, CRM …).
-- External systems authenticate with an API key or an OAuth2 client-credentials token and are scoped to one chamber.

CREATE TABLE integration_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id         uuid NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  key_prefix         text NOT NULL UNIQUE,              -- public part of the API key (lookup)
  key_hash           text NOT NULL,                     -- sha256 of the whole key
  scopes             text[] NOT NULL,
  events             text[] NOT NULL DEFAULT '{*}',     -- subscribed event types ('*' = all)
  webhook_url        text,
  webhook_secret_enc text,                              -- AES-256-GCM encrypted HMAC secret
  is_active          boolean NOT NULL DEFAULT true,
  last_used_at       timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chamber_id, name)
);

-- Transactional outbox: rows are written by triggers in the same transaction as the business change,
-- then delivered to the client's webhook (retry with backoff) and readable by polling (/events?after=).
CREATE TABLE integration_events (
  id              bigserial PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,
  chamber_id      uuid NOT NULL,
  event           text NOT NULL,
  entity          text NOT NULL,
  entity_id       uuid NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','skipped')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_events_due_idx ON integration_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX integration_events_client_idx ON integration_events (client_id, id);

-- Issues may come from another system (e.g. a letter referred to a commission from office automation).
ALTER TABLE issues
  ADD COLUMN source               text NOT NULL DEFAULT 'internal',
  ADD COLUMN integration_client_id uuid REFERENCES integration_clients(id),
  ADD COLUMN external_ref         text,
  ADD COLUMN external_number      text,
  ADD COLUMN external_date        date,
  ADD COLUMN requested_meeting_id uuid REFERENCES meetings(id);
CREATE UNIQUE INDEX issues_external_ref_uq ON issues (integration_client_id, external_ref) WHERE external_ref IS NOT NULL;

-- Execution feedback may be reported by an external system instead of a person.
ALTER TABLE resolution_updates
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN source                text NOT NULL DEFAULT 'user',
  ADD COLUMN integration_client_id uuid REFERENCES integration_clients(id),
  ADD COLUMN external_ref          text;

ALTER TABLE documents ADD COLUMN integration_client_id uuid REFERENCES integration_clients(id);

-- ───────────── Outbox triggers ─────────────
CREATE OR REPLACE FUNCTION integration_enqueue(p_chamber uuid, p_event text, p_entity text, p_id uuid, p_payload jsonb) RETURNS void AS $$
BEGIN
  INSERT INTO integration_events (client_id, chamber_id, event, entity, entity_id, payload)
  SELECT c.id, p_chamber, p_event, p_entity, p_id, p_payload
    FROM integration_clients c
   WHERE c.chamber_id = p_chamber AND c.is_active AND 'events:read' = ANY(c.scopes)
     AND ('*' = ANY(c.events) OR p_event = ANY(c.events));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION integration_resolution_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM integration_enqueue(NEW.chamber_id, 'resolution.created', 'resolution', NEW.id,
      jsonb_build_object('id', NEW.id, 'number', NEW.number, 'commissionId', NEW.commission_id, 'meetingId', NEW.meeting_id,
                         'status', NEW.status, 'dueDate', NEW.due_date));
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.progress IS DISTINCT FROM OLD.progress
     OR NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.text IS DISTINCT FROM OLD.text THEN
    PERFORM integration_enqueue(NEW.chamber_id, 'resolution.updated', 'resolution', NEW.id,
      jsonb_build_object('id', NEW.id, 'number', NEW.number, 'status', NEW.status, 'previousStatus', OLD.status,
                         'progress', NEW.progress, 'dueDate', NEW.due_date));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER resolutions_integration AFTER INSERT OR UPDATE ON resolutions FOR EACH ROW EXECUTE FUNCTION integration_resolution_event();

CREATE OR REPLACE FUNCTION integration_meeting_event() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    PERFORM integration_enqueue(NEW.chamber_id, 'meeting.updated', 'meeting', NEW.id,
      jsonb_build_object('id', NEW.id, 'commissionId', NEW.commission_id, 'number', NEW.number, 'status', NEW.status,
                         'previousStatus', OLD.status, 'scheduledAt', NEW.scheduled_at));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER meetings_integration AFTER UPDATE ON meetings FOR EACH ROW EXECUTE FUNCTION integration_meeting_event();

-- Only issues referred by an external system are reported back (to that system alone).
CREATE OR REPLACE FUNCTION integration_issue_event() RETURNS trigger AS $$
BEGIN
  IF NEW.integration_client_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO integration_events (client_id, chamber_id, event, entity, entity_id, payload)
    SELECT c.id, NEW.chamber_id, 'referral.updated', 'referral', NEW.id,
           jsonb_build_object('id', NEW.id, 'externalRef', NEW.external_ref, 'status', NEW.status, 'previousStatus', OLD.status)
      FROM integration_clients c WHERE c.id = NEW.integration_client_id AND c.is_active AND 'events:read' = ANY(c.scopes);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER issues_integration AFTER UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION integration_issue_event();
