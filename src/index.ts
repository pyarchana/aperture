import "dotenv/config";

import express, { type ErrorRequestHandler } from "express";

import { closeDb, getDb } from "./db.js";
import alertsRouter from "./routes/alerts.js";
import changesRouter from "./routes/changes.js";
import competitorsRouter from "./routes/competitors.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { closeSolari } from "./solari/browser.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use("/competitors", competitorsRouter);
app.use("/changes", changesRouter);
app.use("/alerts", alertsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[api]", err);
  res.status(500).json({
    error: err instanceof Error ? err.message : "internal error",
  });
};
app.use(errorHandler);

// Opens and migrates the database before the first request arrives.
getDb();

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`[api] aperture listening on http://localhost:${port}`);
  startScheduler();
});

function shutdown(signal: string): void {
  console.log(`\n[api] ${signal} received, shutting down.`);
  stopScheduler();
  server.close(() => {
    void closeSolari().finally(() => {
      closeDb();
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
