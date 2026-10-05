-- Facebook Pages (and their linked Instagram accounts) the dashboard may publish to.
CREATE TABLE meta_pages (
  page_id     text PRIMARY KEY,
  name        text NOT NULL,
  ig_user_id  text,
  ig_username text,
  can_post    boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT false,
  is_default  boolean NOT NULL DEFAULT false,
  synced_at   timestamptz NOT NULL DEFAULT now()
);
-- At most one default Page.
CREATE UNIQUE INDEX meta_pages_one_default ON meta_pages ((true)) WHERE is_default;

-- Which account a destination publishes to: a Page id for Facebook, an Instagram user id for
-- Instagram. NULL means "the default Page" (and its linked Instagram account).
ALTER TABLE content_targets ADD COLUMN account_id text;
ALTER TABLE content_targets DROP CONSTRAINT content_targets_content_id_platform_placement_key;
CREATE UNIQUE INDEX content_targets_unique_dest
  ON content_targets (content_id, platform, placement, COALESCE(account_id, ''));
