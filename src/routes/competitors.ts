import { Router } from "express";

import {
  createCompetitor,
  createTarget,
  deleteCompetitor,
  getCompetitor,
  listCompetitors,
  listTargets,
  setCompetitorEnabled,
  type TargetKind,
} from "../db.js";
import { runCompetitor, scheduleCompetitor, unscheduleCompetitor } from "../scheduler.js";

const router = Router();

const TARGET_KINDS: readonly TargetKind[] = ["web", "app", "desktop"];

function parseId(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/", (_req, res) => {
  res.json(listCompetitors());
});

router.post("/", (req, res) => {
  const { name, homepage_url, cron } = req.body ?? {};
  if (typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const competitor = createCompetitor({
    name: name.trim(),
    homepage_url: typeof homepage_url === "string" ? homepage_url : null,
    cron: typeof cron === "string" ? cron : null,
  });

  scheduleCompetitor(competitor.id);
  res.status(201).json(competitor);
});

router.get("/:id", (req, res) => {
  const id = parseId(req.params.id);
  const competitor = id === null ? undefined : getCompetitor(id);
  if (!competitor) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }
  res.json({ ...competitor, targets: listTargets(competitor.id) });
});

router.patch("/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !getCompetitor(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" });
    return;
  }

  setCompetitorEnabled(id, enabled);
  if (enabled) scheduleCompetitor(id);
  else unscheduleCompetitor(id);

  res.json(getCompetitor(id));
});

router.delete("/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !deleteCompetitor(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }
  unscheduleCompetitor(id);
  res.status(204).end();
});

/* --- targets ------------------------------------------------------------ */

router.get("/:id/targets", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !getCompetitor(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }
  res.json(listTargets(id));
});

router.post("/:id/targets", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !getCompetitor(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  const { kind, locator, label } = req.body ?? {};
  if (!TARGET_KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${TARGET_KINDS.join(", ")}` });
    return;
  }
  if (typeof locator !== "string" || locator.trim() === "") {
    res.status(400).json({ error: "locator is required" });
    return;
  }

  res.status(201).json(
    createTarget({
      competitor_id: id,
      kind,
      locator: locator.trim(),
      label: typeof label === "string" ? label : null,
    }),
  );
});

/* --- manual run --------------------------------------------------------- */

/** Triggers a capture pass now instead of waiting for the next cron tick. */
router.post("/:id/run", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !getCompetitor(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  await runCompetitor(id);
  res.json({ ok: true, competitor_id: id });
});

export default router;
