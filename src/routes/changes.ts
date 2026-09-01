import { Router } from "express";

import { getChange, listChanges, listUnanalyzedChanges } from "../db.js";

const router = Router();

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * GET /changes?competitor=1&target=2&min_significance=5&limit=20
 *
 * Detected changes, newest first. `min_significance` filters to analyzed
 * changes only, since unanalyzed rows have a null score.
 */
router.get("/", (req, res) => {
  const limit = parseNumber(req.query.limit);

  res.json(
    listChanges({
      competitorId: parseNumber(req.query.competitor),
      targetId: parseNumber(req.query.target),
      minSignificance: parseNumber(req.query.min_significance),
      limit: limit === undefined ? undefined : Math.min(Math.max(limit, 1), 200),
    }),
  );
});

/** Changes still waiting on the analyzer - useful for spotting a stuck queue. */
router.get("/unanalyzed", (req, res) => {
  const limit = parseNumber(req.query.limit) ?? 20;
  res.json(listUnanalyzedChanges(Math.min(Math.max(limit, 1), 200)));
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  const change = Number.isInteger(id) ? getChange(id) : undefined;
  if (!change) {
    res.status(404).json({ error: "change not found" });
    return;
  }
  res.json(change);
});

export default router;
