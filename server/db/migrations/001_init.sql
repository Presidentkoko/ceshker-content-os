-- Content OS core schema. Lives in its own schema (default content_os) so the
-- n8n tables in the same database are never read or modified.
-- Requires PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','content_manager','approver','viewer')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','paused','completed')),
  target_count     integer,
  starts_on        date,
  ends_on          date,
  lead_magnet_name text,
  lead_magnet_url  text,
  cta_text         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE video_ref_seq;
CREATE TABLE videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE DEFAULT ('VID-' || lpad(nextval('video_ref_seq')::text, 4, '0')),
  source_key       text UNIQUE,
  title            text NOT NULL,
  public_title     text,
  description      text,
  series_no        integer,
  playlist         text,
  drive_file_id    text,
  drive_url        text,
  thumbnail_url    text,
  duration_seconds integer,
  youtube_status   text NOT NULL DEFAULT 'not_uploaded'
                   CHECK (youtube_status IN ('not_uploaded','uploaded_private','scheduled','public')),
  youtube_video_id text UNIQUE,
  youtube_url      text,
  release_at       timestamptz,
  campaign_id      uuid REFERENCES campaigns(id),
  notes            text,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE content_ref_seq;
CREATE TABLE content_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               text NOT NULL UNIQUE DEFAULT ('CT-' || lpad(nextval('content_ref_seq')::text, 4, '0')),
  source            text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('sheet','dashboard')),
  source_key        text UNIQUE,
  source_hash       text,
  locally_modified  boolean NOT NULL DEFAULT false,
  synced_at         timestamptz,
  title             text NOT NULL,
  caption           text,
  description       text,
  cta               text,
  hashtags          text,
  notes             text,
  category          text NOT NULL DEFAULT 'General',
  priority          smallint CHECK (priority BETWEEN 1 AND 3),
  content_type      text NOT NULL DEFAULT 'post'
                    CHECK (content_type IN ('post','story','reel','carousel','video','short','email','event')),
  campaign_id       uuid REFERENCES campaigns(id),
  video_id          uuid REFERENCES videos(id),
  parent_id         uuid REFERENCES content_items(id),
  scheduled_at      timestamptz,
  timezone          text NOT NULL DEFAULT 'America/Chicago',
  approval_status   text NOT NULL DEFAULT 'draft'
                    CHECK (approval_status IN ('draft','pending','approved','rejected','revision_requested')),
  publish_status    text NOT NULL DEFAULT 'unscheduled'
                    CHECK (publish_status IN ('unscheduled','queued','paused','publishing','published','partially_published','failed')),
  version           integer NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id),
  updated_by        uuid REFERENCES users(id),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_sched_idx ON content_items(scheduled_at);
CREATE INDEX content_approval_idx ON content_items(approval_status);
CREATE INDEX content_campaign_idx ON content_items(campaign_id);

-- One row per destination. Unique so the same record cannot target a placement twice.
CREATE TABLE content_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  platform   text NOT NULL CHECK (platform IN ('facebook','instagram','youtube','email','linkedin','tiktok')),
  placement  text NOT NULL CHECK (placement IN ('feed','story','reel','short','video','newsletter','post')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, platform, placement)
);

CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id    uuid REFERENCES content_items(id) ON DELETE CASCADE,
  video_id      uuid REFERENCES videos(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('image','video','thumbnail','document','link')),
  url           text NOT NULL,
  drive_file_id text,
  label         text,
  approved      boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (content_id IS NOT NULL OR video_id IS NOT NULL)
);
CREATE INDEX assets_content_idx ON assets(content_id);
CREATE INDEX assets_video_idx ON assets(video_id);

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id      uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action IN ('submitted','approved','rejected','revision_requested','imported')),
  comment         text,
  content_version integer NOT NULL,
  actor_id        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_content_idx ON approvals(content_id);

-- Publishing queue. The partial unique index means a target can only have one
-- live queue entry at a time.
CREATE TABLE queue_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id      uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  target_id       uuid NOT NULL REFERENCES content_targets(id) ON DELETE CASCADE,
  run_at          timestamptz NOT NULL,
  state           text NOT NULL DEFAULT 'scheduled'
                  CHECK (state IN ('scheduled','paused','dispatching','published','failed','cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE,
  content_version integer NOT NULL,
  last_error      text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX queue_live_target_uidx ON queue_items(target_id)
  WHERE state IN ('scheduled','paused','dispatching','failed');
CREATE INDEX queue_run_idx ON queue_items(state, run_at);

-- A target can be published exactly once. This is the hard guard against double posting.
CREATE TABLE publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id       uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  target_id        uuid NOT NULL UNIQUE REFERENCES content_targets(id) ON DELETE CASCADE,
  platform         text NOT NULL,
  method           text NOT NULL CHECK (method IN ('automated','manual')),
  platform_post_id text,
  public_url       text,
  execution_id     text,
  published_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('dry_run','publish','sheet_sync','validation','connection_test')),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  content_id    uuid REFERENCES content_items(id) ON DELETE SET NULL,
  queue_item_id uuid REFERENCES queue_items(id) ON DELETE SET NULL,
  execution_id  text,
  retry_of      uuid REFERENCES workflow_runs(id),
  summary       text,
  request       jsonb,
  response      jsonb,
  error         text,
  triggered_by  uuid REFERENCES users(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX workflow_runs_started_idx ON workflow_runs(started_at DESC);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id),
  actor_email  text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  content_ref  text,
  previous     jsonb,
  next         jsonb,
  execution_id text,
  result       text NOT NULL CHECK (result IN ('success','failure','denied')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);

CREATE TABLE connections (
  key                   text PRIMARY KEY,
  label                 text NOT NULL,
  status                text NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('connected','disconnected','degraded','not_configured','unknown')),
  last_success_at       timestamptz,
  last_checked_at       timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  automation_enabled    boolean NOT NULL DEFAULT false,
  automation_changed_by uuid REFERENCES users(id),
  automation_changed_at timestamptz
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
