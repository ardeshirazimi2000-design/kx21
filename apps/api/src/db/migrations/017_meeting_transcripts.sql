-- Draft minutes from a meeting's recording: the recording is turned into text on the organisation's own server
-- (a Whisper speech-to-text service), then a local language model (Ollama) drafts the «متن جلسه» and the draft
-- resolutions. Only the secretary sees them; nothing enters the minutes or the resolutions until they review it.
CREATE TABLE meeting_transcripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id   uuid NOT NULL REFERENCES chambers(id),
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,   -- the recording (or a text file of the transcript)
  source       text NOT NULL CHECK (source IN ('recording', 'text')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'transcribing', 'drafting', 'done', 'failed', 'cancelled')),
  transcript   text,
  discussion   text,                                               -- drafted «متن جلسه» (Markdown)
  resolutions  jsonb NOT NULL DEFAULT '[]',                        -- [{text, agendaItemId, responsible, deadline}]
  error        text,
  stt_model    text,
  llm_model    text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  applied_at   timestamptz                                         -- when the drafted text was put into the minutes
);
CREATE INDEX meeting_transcripts_meeting_idx ON meeting_transcripts (meeting_id, created_at DESC);
CREATE INDEX meeting_transcripts_open_idx ON meeting_transcripts (created_at) WHERE status IN ('queued', 'transcribing', 'drafting');
