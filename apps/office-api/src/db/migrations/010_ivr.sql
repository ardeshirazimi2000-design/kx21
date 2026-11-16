-- Auto-attendant (تلفن گویا) of the city line: the voice prompts recorded or uploaded in Rasa.
-- Stored as 8 kHz mono 16-bit PCM WAV (what Asterisk plays without transcoding); written into the PBX volume on sync.
CREATE TABLE communication_sounds (
  key         text PRIMARY KEY CHECK (key IN ('greeting', 'closed')),
  data        bytea NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
