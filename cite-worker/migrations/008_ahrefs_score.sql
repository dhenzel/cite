-- Recompute Placement Score from Ahrefs only: 50% Domain Rating + 50% organic
-- traffic (log10-scaled to 0–100). Moz DA / Majestic TF/CF / Moz spam are not
-- inputs. Use ln(x)/ln(10) so D1 does not need SQLite log().
UPDATE sites SET cite_score = MAX(0, MIN(100, ROUND(
  0.5 * COALESCE(dr, 0)
  + 0.5 * MIN(100.0, 20.0 * (ln(COALESCE(traffic, 0) + 1.0) / ln(10.0)))
)));
