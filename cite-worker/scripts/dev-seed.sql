-- Synthetic local dev seed for cite-worker (NOT real publisher data).
-- Every domain here is a fabricated example.* placeholder. Use it to run the
-- Worker locally against a local D1 without the private inventory export:
--   npx wrangler d1 execute cite-v0 --local --file=schema.sql
--   npx wrangler d1 execute cite-v0 --local --file=scripts/dev-seed.sql
-- Safe to re-run: rows are inserted with fixed handles via INSERT OR REPLACE.

INSERT OR REPLACE INTO sites
  (id, domain, contact_name, contact_email, niche, subniche, seller_price, markup, listed_price,
   da, dr, tf, cf, spam, traffic, traffic_band, cite_score, link_attribute, max_links_per_post,
   turnaround_sla_days, status, acquisition_mode, cost_type, agent_instructions, metrics_updated_at)
VALUES
  ('cs_dev0finance01','finance-example-01.test','Dev Fixture','fixture@example.test','Finance','Fintech',180,1.6,320,
    58,64,38,44,0,42000,'10k–50k/mo',72,'dofollow',2,14,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0finance02','finance-example-02.test','Dev Fixture','fixture@example.test','Finance','Investing',95,1.6,160,
    47,52,30,40,0,8500,'5k–10k/mo',61,'dofollow',1,21,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0business01','business-example-01.test','Dev Fixture','fixture@example.test','Business','B2B SaaS',260,1.6,420,
    66,74,45,50,0,120000,'50k–250k/mo',83,'dofollow',2,10,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0tech00001','tech-example-01.test','Dev Fixture','fixture@example.test','Tech','Developer Tools',140,1.6,240,
    54,60,35,42,0,30000,'10k–50k/mo',69,'sponsored',3,14,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0health001','health-example-01.test','Dev Fixture','fixture@example.test','Health & Wellness','Nutrition',70,1.6,120,
    41,45,28,38,1,3200,'1k–5k/mo',52,'nofollow',1,28,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0life00001','lifestyle-example-01.test','Dev Fixture','fixture@example.test','Lifestyle','Travel',55,1.6,90,
    38,40,25,35,0,1800,'1k–5k/mo',47,'unknown',1,30,'active','paid_placement','paid',NULL,'2026-01-15'),
  ('cs_dev0free0self1','selfserve-example.test',NULL,NULL,'Tech','Publishing Platform',0,1.6,0,
    72,80,50,55,0,500000,'250k+/mo',78,'nofollow',1,NULL,'active','self_serve','free',
    'Register a free account on the platform and publish your article directly, including one link to your target URL.','2026-01-15'),
  ('cs_dev0free0edit1','editorial-example.test',NULL,NULL,'Business','Startups',0,1.6,0,
    60,66,40,46,0,45000,'10k–50k/mo',71,'dofollow',1,NULL,'active','apply_editorial','free',NULL,'2026-01-15');

INSERT OR REPLACE INTO site_content (site_id, summary, writes_about, recent_titles, source) VALUES
  ('cs_dev0finance01','Covers personal finance, fintech products and payments for a B2B audience.',
    '["finance","fintech","payments","b2b"]','["A guide to embedded payments","How BNPL underwriting works"]','crawl'),
  ('cs_dev0business01','Business strategy and B2B SaaS growth playbooks.',
    '["business","saas","growth","b2b"]','["PLG vs sales-led","Pricing your SaaS tiers"]','crawl'),
  ('cs_dev0tech00001','Developer tooling reviews and engineering tutorials.',
    '["tech","developer tools","engineering"]','["Choosing a CI provider","API-first design"]','crawl');
