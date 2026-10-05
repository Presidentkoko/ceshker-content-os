-- Canva MCP: a second Canva grant (mcp.canva.com) used to inspect and fix designs element by
-- element, which Canva Connect cannot do. Each Canva image records its design and a brand check.
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_provider_check;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_provider_check CHECK (provider IN ('google','canva','canva_mcp'));

ALTER TABLE assets ADD COLUMN canva_design_id text;
-- {status: pass|fail|review|error, detail, found_approved[], found_blocked[], checked_at}
ALTER TABLE assets ADD COLUMN brand_check jsonb;

-- Approved and known-fake logos (Canva media ids). Editable under Settings via the API.
INSERT INTO settings (key, value) VALUES ('brand_rules', '{
  "approved_logo_asset_ids": ["MAHWr4iPo6k"],
  "blocked_asset_ids": ["MAHWIeM0tWs", "MAHWlmZFx50"],
  "logo_asset_for_fix": "MAHWr4iPo6k"
}'::jsonb) ON CONFLICT (key) DO NOTHING;
