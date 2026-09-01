import { Router } from "express";

import { listAlerts, markAlert, type AlertStatus } from "../db.js";

const router = Router();

const STATUSES: readonly AlertStatus[] = ["pending", "sent", "failed"];

function isStatus(value: unknown): value is AlertStatus {
  return typeof value === "string" && STATUSES.includes(value as AlertStatus);
}

/** GET /alerts?status=pending&limit=50 */
router.get("/", (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !isStatus(status)) {
    res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    return;
  }

  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;

  res.json(listAlerts(status, limit));
});

/**
 * PATCH /alerts/:id  { "status": "sent" }
 *
 * Delivery lives outside this service - whatever ships the alert marks it
 * here once it has been sent (or failed).
 */
router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "alert not found" });
    return;
  }

  const { status } = req.body ?? {};
  if (!isStatus(status)) {
    res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    return;
  }

  if (!markAlert(id, status)) {
    res.status(404).json({ error: "alert not found" });
    return;
  }
  res.json({ ok: true, id, status });
});

export default router;
