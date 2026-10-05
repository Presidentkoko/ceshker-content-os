-- Direct Google (YouTube + Drive) connection via OAuth, and YouTube state per library video.

-- One row per provider. Tokens are AES-256-GCM encrypted by the app; never returned by the API.
CREATE TABLE oauth_tokens (
  provider          text PRIMARY KEY CHECK (provider IN ('google')),
  account_id        text,
  account_name      text,
  scopes            text NOT NULL,
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz NOT NULL,
  connected_by      uuid REFERENCES users(id),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE videos
  ADD COLUMN youtube_privacy    text CHECK (youtube_privacy IN ('private','unlisted','public')),
  ADD COLUMN youtube_publish_at timestamptz,
  ADD COLUMN youtube_title      text,
  ADD COLUMN youtube_views      bigint,
  ADD COLUMN youtube_synced_at  timestamptz,
  ADD COLUMN youtube_upload_status text;

CREATE TABLE youtube_playlists (
  name                text PRIMARY KEY,
  youtube_playlist_id text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Records which library videos have been added to which YouTube playlist.
CREATE TABLE youtube_playlist_items (
  video_id            uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  youtube_playlist_id text NOT NULL,
  playlist_item_id    text NOT NULL,
  PRIMARY KEY (video_id, youtube_playlist_id)
);

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_kind_check
  CHECK (kind IN ('dry_run','publish','sheet_sync','validation','connection_test','youtube_sync','youtube_upload','youtube_update'));
