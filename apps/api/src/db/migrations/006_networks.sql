-- Thematic networks of commissions across provincial chambers (شبکه‌های موضوعی کمیسیون‌ها).
-- Commissions on the same subject in different chambers join a national network, share resolutions
-- and endorse each other's; a resolution endorsed by enough chambers becomes a national proposal.

CREATE TABLE networks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  description       text,
  -- Number of chambers (the originating one included) that turns a shared resolution into a national proposal.
  endorse_threshold int  NOT NULL DEFAULT 3 CHECK (endorse_threshold >= 2),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- دبیر شبکه: coordinates the network at the national level.
CREATE TABLE network_coordinators (
  network_id uuid NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (network_id, user_id)
);

CREATE TABLE network_commissions (
  network_id    uuid NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  commission_id uuid NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  added_by      uuid REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, commission_id)
);
CREATE INDEX network_commissions_commission_idx ON network_commissions (commission_id);

-- A resolution published to the networks of its commission.
ALTER TABLE resolutions
  ADD COLUMN shared_at  timestamptz,
  ADD COLUMN shared_by  uuid REFERENCES users(id),
  ADD COLUMN share_note text;
CREATE INDEX resolutions_shared_idx ON resolutions (commission_id) WHERE shared_at IS NOT NULL;

-- Support (حمایت) of a shared resolution by another commission.
CREATE TABLE resolution_endorsements (
  resolution_id uuid NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  commission_id uuid NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  chamber_id    uuid NOT NULL REFERENCES chambers(id),
  user_id       uuid REFERENCES users(id),
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution_id, commission_id)
);

-- National proposals: shared resolutions that reached the network's threshold, followed up by its coordinators.
CREATE TABLE network_proposals (
  network_id    uuid NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  resolution_id uuid NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  reached_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','forwarded','closed')),
  response      text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, resolution_id)
);
