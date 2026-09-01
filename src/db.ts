import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type TargetKind = "web" | "app" | "desktop";
export type AlertStatus = "pending" | "sent" | "failed";

export interface Competitor {
  id: number;
  name: string;
  homepage_url: string | null;
  cron: string | null;
  enabled: number;
  created_at: string;
}

export interface Target {
  id: number;
  competitor_id: number;
  kind: TargetKind;
  /** URL for `web`, app identifier / launch target for `app` and `desktop`. */
  locator: string;
  label: string | null;
  enabled: number;
  created_at: string;
}

export interface Snapshot {
  id: number;
  target_id: number;
  captured_at: string;
  /** sha256 of `text_content`, used to skip no-op captures cheaply. */
  content_hash: string;
  text_content: string;
  /** Relative path under SNAPSHOT_DIR for the raw artifact (html, png, ...). */
  artifact_path: string | null;
}

export interface Change {
  id: number;
  target_id: number;
  from_snapshot_id: number;
  to_snapshot_id: number;
  detected_at: string;
  diff: string;
  /** 0-10, written by the analyzer. Null until analysis has run. */
  significance: number | null;
  category: string | null;
  summary: string | null;
  details: string | null;
  analyzed_at: string | null;
}

export interface Alert {
  id: number;
  change_id: number;
  created_at: string;
  channel: string;
  status: AlertStatus;
  body: string;
  sent_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS competitors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  homepage_url  TEXT,
  cron          TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('web', 'app', 'desktop')),
  locator       TEXT    NOT NULL,
  label         TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (competitor_id, kind, locator)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  captured_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  content_hash  TEXT    NOT NULL,
  text_content  TEXT    NOT NULL,
  artifact_path TEXT
);

CREATE TABLE IF NOT EXISTS changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id        INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  from_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  to_snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  detected_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  diff             TEXT    NOT NULL,
  significance     INTEGER,
  category         TEXT,
  summary          TEXT,
  details          TEXT,
  analyzed_at      TEXT,
  UNIQUE (from_snapshot_id, to_snapshot_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id  INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  channel    TEXT    NOT NULL DEFAULT 'log',
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  body       TEXT    NOT NULL,
  sent_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_targets_competitor ON targets (competitor_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_target   ON snapshots (target_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_target     ON changes (target_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status      ON alerts (status, created_at DESC);
`;

let handle: Database.Database | null = null;

/**
 * Opens (and on first call, migrates) the SQLite database.
 *
 * DATABASE_PATH is read lazily so dotenv only needs to be loaded before the
 * first call, not before this module is imported.
 */
export function getDb(): Database.Database {
  if (handle) return handle;

  const file = process.env.DATABASE_PATH ?? "./aperture.db";
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  handle = db;
  return db;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/* ---------------------------------------------------------------------------
 * Competitors
 * ------------------------------------------------------------------------ */

export function listCompetitors(): Competitor[] {
  return getDb()
    .prepare("SELECT * FROM competitors ORDER BY name")
    .all() as Competitor[];
}

export function getCompetitor(id: number): Competitor | undefined {
  return getDb().prepare("SELECT * FROM competitors WHERE id = ?").get(id) as
    | Competitor
    | undefined;
}

export function createCompetitor(input: {
  name: string;
  homepage_url?: string | null;
  cron?: string | null;
}): Competitor {
  const info = getDb()
    .prepare("INSERT INTO competitors (name, homepage_url, cron) VALUES (?, ?, ?)")
    .run(input.name, input.homepage_url ?? null, input.cron ?? null);
  return getCompetitor(Number(info.lastInsertRowid))!;
}

export function setCompetitorEnabled(id: number, enabled: boolean): boolean {
  return (
    getDb()
      .prepare("UPDATE competitors SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id).changes > 0
  );
}

export function deleteCompetitor(id: number): boolean {
  return (
    getDb().prepare("DELETE FROM competitors WHERE id = ?").run(id).changes > 0
  );
}

/* ---------------------------------------------------------------------------
 * Targets
 * ------------------------------------------------------------------------ */

export function listTargets(competitorId?: number): Target[] {
  const db = getDb();
  if (competitorId === undefined) {
    return db
      .prepare("SELECT * FROM targets ORDER BY competitor_id, id")
      .all() as Target[];
  }
  return db
    .prepare("SELECT * FROM targets WHERE competitor_id = ? ORDER BY id")
    .all(competitorId) as Target[];
}

/** Every enabled target belonging to an enabled competitor. */
export function listActiveTargets(): Target[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM targets t
         JOIN competitors c ON c.id = t.competitor_id
        WHERE t.enabled = 1 AND c.enabled = 1
        ORDER BY t.competitor_id, t.id`,
    )
    .all() as Target[];
}

export function createTarget(input: {
  competitor_id: number;
  kind: TargetKind;
  locator: string;
  label?: string | null;
}): Target {
  const info = getDb()
    .prepare(
      "INSERT INTO targets (competitor_id, kind, locator, label) VALUES (?, ?, ?, ?)",
    )
    .run(input.competitor_id, input.kind, input.locator, input.label ?? null);
  return getDb()
    .prepare("SELECT * FROM targets WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Target;
}

/* ---------------------------------------------------------------------------
 * Snapshots
 * ------------------------------------------------------------------------ */

export function latestSnapshot(targetId: number): Snapshot | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM snapshots WHERE target_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    )
    .get(targetId) as Snapshot | undefined;
}

export function insertSnapshot(input: {
  target_id: number;
  content_hash: string;
  text_content: string;
  artifact_path?: string | null;
}): Snapshot {
  const info = getDb()
    .prepare(
      "INSERT INTO snapshots (target_id, content_hash, text_content, artifact_path) VALUES (?, ?, ?, ?)",
    )
    .run(
      input.target_id,
      input.content_hash,
      input.text_content,
      input.artifact_path ?? null,
    );
  return getDb()
    .prepare("SELECT * FROM snapshots WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Snapshot;
}

/* ---------------------------------------------------------------------------
 * Changes
 * ------------------------------------------------------------------------ */

export function insertChange(input: {
  target_id: number;
  from_snapshot_id: number;
  to_snapshot_id: number;
  diff: string;
}): Change {
  const info = getDb()
    .prepare(
      "INSERT INTO changes (target_id, from_snapshot_id, to_snapshot_id, diff) VALUES (?, ?, ?, ?)",
    )
    .run(input.target_id, input.from_snapshot_id, input.to_snapshot_id, input.diff);
  return getDb()
    .prepare("SELECT * FROM changes WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Change;
}

export function getChange(id: number): Change | undefined {
  return getDb().prepare("SELECT * FROM changes WHERE id = ?").get(id) as
    | Change
    | undefined;
}

export function listChanges(
  options: {
    competitorId?: number;
    targetId?: number;
    minSignificance?: number;
    limit?: number;
  } = {},
): Change[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.competitorId !== undefined) {
    clauses.push("target_id IN (SELECT id FROM targets WHERE competitor_id = ?)");
    params.push(options.competitorId);
  }
  if (options.targetId !== undefined) {
    clauses.push("target_id = ?");
    params.push(options.targetId);
  }
  if (options.minSignificance !== undefined) {
    clauses.push("significance >= ?");
    params.push(options.minSignificance);
  }
  params.push(options.limit ?? 50);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(
      `SELECT * FROM changes ${where} ORDER BY detected_at DESC, id DESC LIMIT ?`,
    )
    .all(...params) as Change[];
}

export function listUnanalyzedChanges(limit = 20): Change[] {
  return getDb()
    .prepare(
      "SELECT * FROM changes WHERE analyzed_at IS NULL ORDER BY detected_at LIMIT ?",
    )
    .all(limit) as Change[];
}

export function saveAnalysis(
  changeId: number,
  analysis: {
    significance: number;
    category: string;
    summary: string;
    details: string;
  },
): void {
  getDb()
    .prepare(
      `UPDATE changes
          SET significance = ?, category = ?, summary = ?, details = ?,
              analyzed_at = datetime('now')
        WHERE id = ?`,
    )
    .run(
      analysis.significance,
      analysis.category,
      analysis.summary,
      analysis.details,
      changeId,
    );
}

/* ---------------------------------------------------------------------------
 * Alerts
 * ------------------------------------------------------------------------ */

export function listAlerts(status?: AlertStatus, limit = 50): Alert[] {
  const db = getDb();
  if (status === undefined) {
    return db
      .prepare("SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as Alert[];
  }
  return db
    .prepare(
      "SELECT * FROM alerts WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(status, limit) as Alert[];
}

export function createAlert(input: {
  change_id: number;
  channel?: string;
  body: string;
}): Alert {
  const info = getDb()
    .prepare("INSERT INTO alerts (change_id, channel, body) VALUES (?, ?, ?)")
    .run(input.change_id, input.channel ?? "log", input.body);
  return getDb()
    .prepare("SELECT * FROM alerts WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Alert;
}

export function markAlert(id: number, status: AlertStatus): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE alerts
            SET status = ?,
                sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END
          WHERE id = ?`,
      )
      .run(status, status, id).changes > 0
  );
}
