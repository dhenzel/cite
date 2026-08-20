-- 009: richer crawl/LLM publisher profiles for get_writing_brief.
-- Public columns stay brand-scrubbed. summary_private is operator-only.
ALTER TABLE site_content ADD COLUMN audience TEXT;
ALTER TABLE site_content ADD COLUMN tone TEXT;
ALTER TABLE site_content ADD COLUMN post_shape TEXT;
ALTER TABLE site_content ADD COLUMN typical_length_words INTEGER;
ALTER TABLE site_content ADD COLUMN do_fit TEXT;
ALTER TABLE site_content ADD COLUMN dont_fit TEXT;
ALTER TABLE site_content ADD COLUMN summary_private TEXT;
ALTER TABLE site_content ADD COLUMN enrich_status TEXT;
