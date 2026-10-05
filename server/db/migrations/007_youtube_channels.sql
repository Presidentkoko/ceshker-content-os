-- More than one YouTube channel: one row per connected channel. The primary channel (the NFAMation
-- library, YOUTUBE_CHANNEL_ID) is where uploads go; others are connected for their stats.
CREATE TABLE youtube_channels (
  channel_id        text PRIMARY KEY,
  title             text NOT NULL,
  scopes            text NOT NULL,
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz NOT NULL,
  is_primary        boolean NOT NULL DEFAULT false,
  connected_by      uuid REFERENCES users(id),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX youtube_channels_one_primary ON youtube_channels (is_primary) WHERE is_primary;

-- The existing single connection becomes the primary channel.
INSERT INTO youtube_channels (channel_id, title, scopes, access_token_enc, refresh_token_enc, expires_at, is_primary, connected_by, connected_at)
  SELECT account_id, COALESCE(account_name, 'YouTube channel'), scopes, access_token_enc, refresh_token_enc, expires_at, true, connected_by, connected_at
    FROM oauth_tokens WHERE provider = 'google' AND account_id IS NOT NULL;
DELETE FROM oauth_tokens WHERE provider = 'google';
