-- Canva Connect: the OAuth grant is stored like Google's, and each generation is a workflow run.
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_provider_check;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_provider_check CHECK (provider IN ('google','canva'));

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_kind_check
  CHECK (kind IN ('dry_run','publish','sheet_sync','validation','connection_test','youtube_sync','youtube_upload','youtube_update','canva_generate'));

CREATE INDEX workflow_runs_canva_idx ON workflow_runs(content_id, started_at DESC) WHERE kind = 'canva_generate';
