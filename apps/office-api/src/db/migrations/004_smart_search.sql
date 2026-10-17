-- Smart topic search (جستجوی هوشمند): a ranked term index over letters (BM25), related-letter lookups, and an
-- optional AI provider (OpenAI-compatible, ideally a model running on the organisation's own server).

CREATE TABLE letter_index (
  letter_id       uuid PRIMARY KEY REFERENCES letters(id) ON DELETE CASCADE,
  len             real NOT NULL,                 -- weighted term count (BM25 length normalisation)
  content_hash    text NOT NULL,                 -- what was indexed; the embedding is redone only when it changes
  indexed_at      timestamptz NOT NULL DEFAULT now(),
  embedding       real[],                        -- from the AI provider; only for unclassified letters
  embedding_model text,
  embedded_at     timestamptz
);

-- Normalised, lightly stemmed terms (and adjacent-word phrases, joined with "_") with field-weighted frequency.
CREATE TABLE letter_terms (
  letter_id uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  term      text NOT NULL,
  weight    real NOT NULL,
  PRIMARY KEY (letter_id, term)
);
CREATE INDEX letter_terms_term_idx ON letter_terms (term);

ALTER TABLE integrations DROP CONSTRAINT integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('meetings','accounting','crm','government','intake','ai'));
