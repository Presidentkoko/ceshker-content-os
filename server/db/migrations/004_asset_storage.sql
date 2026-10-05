-- Stored copies of imported media (e.g. Canva exports, whose download links expire).
ALTER TABLE assets ADD COLUMN data bytea;
ALTER TABLE assets ADD COLUMN mime text;
ALTER TABLE assets ADD COLUMN size_bytes integer;
