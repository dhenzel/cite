-- 007: extra Ahrefs Site Explorer overview stats for the buyer MCP.
-- DR + organic traffic already live on dr / traffic. These columns fill in
-- when we refresh from Ahrefs; omitted from buyer payloads until present.
ALTER TABLE sites ADD COLUMN ahrefs_organic_keywords REAL;
ALTER TABLE sites ADD COLUMN ahrefs_referring_domains REAL;
ALTER TABLE sites ADD COLUMN ahrefs_backlinks REAL;
ALTER TABLE sites ADD COLUMN ahrefs_rank REAL;
ALTER TABLE sites ADD COLUMN ahrefs_organic_value REAL;
