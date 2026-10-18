-- Similar resolutions across the commission networks (یافتن مصوبات مشابه).
-- With an embedding engine (AI_BASE_URL) texts are compared by meaning; pg_trgm is the text-based fallback.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE resolution_embeddings (
  resolution_id uuid PRIMARY KEY REFERENCES resolutions(id) ON DELETE CASCADE,
  model         text NOT NULL,
  text_hash     text NOT NULL,
  embedding     real[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- «مرتبط نیست»: a commission hides a suggested resolution.
CREATE TABLE network_suggestion_dismissals (
  resolution_id uuid NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  commission_id uuid NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution_id, commission_id)
);
