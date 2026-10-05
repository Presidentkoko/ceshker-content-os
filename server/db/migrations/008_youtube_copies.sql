-- When the main YouTube channel changes, the library's links to the old channel's videos are kept
-- here (the videos stay on YouTube untouched), so the same library videos can go to the new channel.
CREATE TABLE youtube_copies (
  youtube_video_id text PRIMARY KEY,
  channel_id       text NOT NULL,
  video_id         uuid REFERENCES videos(id) ON DELETE SET NULL,
  title            text,
  url              text,
  status           text,
  privacy          text,
  publish_at       timestamptz,
  views            bigint,
  moved_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_copies_video_idx ON youtube_copies (video_id);
