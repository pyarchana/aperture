import "dotenv/config";

import cors from "cors";
import express from "express";

import db, { type MonitorType } from "./db.js";

const app = express();

app.use(cors());
app.use(express.json());

const MONITOR_TYPES: MonitorType[] = ["web", "app", "desktop"];

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* ---------------------------------------------------------------------------
 * Competitors
 * ------------------------------------------------------------------------ */

app.get("/competitors", (_req, res) => {
  res.json(db.getCompetitors());
});

app.post("/competitors", (req, res) => {
  const { name, url, monitor_type } = req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof url !== "string" || url.trim() === "") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  if (!MONITOR_TYPES.includes(monitor_type)) {
    res.status(400).json({
      error: `monitor_type must be one of: ${MONITOR_TYPES.join(", ")}`,
    });
    return;
  }

  const competitor = db.addCompetitor({
    name: name.trim(),
    url: url.trim(),
    monitor_type,
  });
  res.status(201).json(competitor);
});

app.get("/competitors/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const competitor = db.getCompetitorById(id);
  if (!competitor) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  res.json({
    ...competitor,
    latest_snapshot: db.getLatestSnapshot(id) ?? null,
  });
});

app.get("/competitors/:id/snapshots", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  if (!db.getCompetitorById(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  res.json(db.getSnapshotsByCompetitor(id));
});

app.get("/competitors/:id/changes", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  if (!db.getCompetitorById(id)) {
    res.status(404).json({ error: "competitor not found" });
    return;
  }

  res.json(db.getChanges({ competitorId: id }));
});

/* ---------------------------------------------------------------------------
 * Alerts
 * ------------------------------------------------------------------------ */

app.get("/alerts", (req, res) => {
  // ?unread=true narrows to alerts that have not been read yet.
  const unreadOnly = req.query.unread === "true";
  res.json(db.getAlerts({ unreadOnly }));
});

app.patch("/alerts/:id/read", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  if (!db.markAlertRead(id)) {
    res.status(404).json({ error: "alert not found" });
    return;
  }

  res.json({ ok: true, id });
});

/* ---------------------------------------------------------------------------
 * Fallbacks
 * ------------------------------------------------------------------------ */

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Four args marks this as Express's error handler, so `next` must stay.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[api]", err);
    res.status(500).json({ error: err.message });
  },
);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`[api] aperture listening on http://localhost:${port}`);
});

function shutdown(signal: string): void {
  console.log(`[api] ${signal} received, shutting down.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
