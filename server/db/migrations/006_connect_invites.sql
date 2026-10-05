-- One-time links that let a channel owner approve the YouTube connection without a dashboard
-- login. Only a hash of the token is stored; a link works once and expires.
CREATE TABLE connect_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('google')),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  opened_at   timestamptz,
  used_at     timestamptz,
  revoked_at  timestamptz,
  result      text
);
CREATE INDEX connect_invites_open_idx ON connect_invites(provider) WHERE used_at IS NULL AND revoked_at IS NULL;
