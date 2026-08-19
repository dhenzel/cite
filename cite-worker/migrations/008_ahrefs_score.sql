-- Recompute Placement Score from Ahrefs only: 50% Domain Rating + 50% organic
-- traffic (log10-scaled to 0–100). Moz DA / Majestic TF/CF / Moz spam are not
-- inputs. SQLite log() is base-10 (3.35+; D1).
UPDATE sites SET cite_score = MAX(0, MIN(100, ROUND(
  0.5 * COALESCE(dr, 0)
  + 0.5 * MIN(100.0, 20.0 * log(COALESCE(traffic, 0) + 1.0))
)));
