import Database from "better-sqlite3";

/**
 * SQLite persistence layer for aperture.
 *
 * Row interfaces mirror what SQLite actually stores: booleans are 0/1
 * integers and timestamps are UTC strings from `datetime('now')`.
 */

export type MonitorType = "web" | "app" | "desktop";
export type Severity = "low" | "medium" | "high" | "critical";

/** The only classifications the analyzer may produce. */
export const CHANGE_TYPES = [
  "pricing_change",
  "new_feature",
  "ui_redesign",
  "content_update",
  "no_change",
] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface Competitor {
  id: number;
  name: string;
  url: string;
  monitor_type: MonitorType;
  created_at: string;
  last_checked: string | null;
}

export interface Snapshot {
  id: number;
  competitor_id: number;
  screenshot_path: string | null;
  html_hash: string;
  text_content: string;
  captured_at: string;
}

export interface Change {
  id: number;
  snapshot_id: number;
  /** Null for the first change on a competitor, which has nothing to compare to. */
  previous_snapshot_id: number | null;
  change_type: ChangeType;
  description: string;
  /** 0.0 - 1.0. */
  confidence: number;
  /** 0 or 1. */
  verified: number;
  desktop_screenshot_path: string | null;
  created_at: string;
}

export interface Alert {
  id: number;
  change_id: number;
  summary: string;
  severity: Severity;
  /** 0 = unread, 1 = read. */
  read_status: number;
  created_at: string;
}

/** Shared by the table definition and the migration, so they cannot drift. */
const CHANGE_TYPE_CHECK = `CHECK (change_type IN (${CHANGE_TYPES.map((t) => `'${t}'`).join(", ")}))`;

const CHANGES_COLUMNS = `
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id             INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  previous_snapshot_id    INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  change_type             TEXT    NOT NULL ${CHANGE_TYPE_CHECK},
  description             TEXT    NOT NULL,
  confidence              REAL    NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  verified                INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  desktop_screenshot_path TEXT,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS competitors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  monitor_type TEXT    NOT NULL CHECK (monitor_type IN ('web', 'app', 'desktop')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_checked TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id   INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  screenshot_path TEXT,
  html_hash       TEXT    NOT NULL,
  text_content    TEXT    NOT NULL,
  captured_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS changes (${CHANGES_COLUMNS});

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id   INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  summary     TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'medium'
                      CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  read_status INTEGER NOT NULL DEFAULT 0 CHECK (read_status IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_competitor ON snapshots (competitor_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_snapshot     ON changes (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_changes_created      ON changes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_change        ON alerts (change_id);
CREATE INDEX IF NOT EXISTS idx_alerts_unread        ON alerts (read_status, created_at DESC);
`;

export class ApertureDatabase {
  private readonly db: Database.Database;

  constructor(file = "aperture.db") {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrateChangeTypeCheck();
  }

  /**
   * Retrofits the change_type CHECK onto databases created before it existed.
   *
   * `CREATE TABLE IF NOT EXISTS` silently skips an existing table, so without
   * this a database created earlier would never gain the constraint. SQLite
   * cannot add one in place, so the table is rebuilt using the documented
   * procedure. Foreign keys are off for the swap because alerts.change_id
   * references this table, then re-enabled and verified.
   */
  private migrateChangeTypeCheck(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'changes'")
      .get() as { sql: string } | undefined;

    if (!table || table.sql.includes("CHECK (change_type")) return;

    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec(`
        BEGIN;
        CREATE TABLE changes_migrated (${CHANGES_COLUMNS});
        INSERT INTO changes_migrated
          SELECT id, snapshot_id, previous_snapshot_id, change_type, description,
                 confidence, verified, desktop_screenshot_path, created_at
            FROM changes;
        DROP TABLE changes;
        ALTER TABLE changes_migrated RENAME TO changes;
        COMMIT;
      `);
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw new Error(
        "Could not add the change_type constraint - a row in 'changes' holds a " +
          `value outside [${CHANGE_TYPES.join(", ")}]. ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    } finally {
      this.db.pragma("foreign_keys = ON");
    }

    const orphans = this.db.pragma("foreign_key_check") as unknown[];
    if (orphans.length > 0) {
      throw new Error(
        `change_type migration left ${orphans.length} orphaned alert row(s).`,
      );
    }

    // DROP TABLE took the table's indexes with it; SCHEMA recreates them.
    this.db.exec(SCHEMA);
    console.log("[db] migrated: added change_type constraint to 'changes'.");
  }

  /** Underlying handle, for migrations or ad-hoc queries. */
  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /* -------------------------------------------------------------------------
   * Competitors
   * ---------------------------------------------------------------------- */

  addCompetitor(input: {
    name: string;
    url: string;
    monitor_type: MonitorType;
  }): Competitor {
    const info = this.db
      .prepare("INSERT INTO competitors (name, url, monitor_type) VALUES (?, ?, ?)")
      .run(input.name, input.url, input.monitor_type);
    return this.getCompetitorById(Number(info.lastInsertRowid))!;
  }

  getCompetitors(): Competitor[] {
    return this.db
      .prepare("SELECT * FROM competitors ORDER BY id")
      .all() as Competitor[];
  }

  getCompetitorById(id: number): Competitor | undefined {
    return this.db.prepare("SELECT * FROM competitors WHERE id = ?").get(id) as
      | Competitor
      | undefined;
  }

  /** Stamps `last_checked` with the current UTC time. */
  updateLastChecked(competitorId: number): boolean {
    return (
      this.db
        .prepare("UPDATE competitors SET last_checked = datetime('now') WHERE id = ?")
        .run(competitorId).changes > 0
    );
  }

  /* -------------------------------------------------------------------------
   * Snapshots
   * ---------------------------------------------------------------------- */

  addSnapshot(input: {
    competitor_id: number;
    html_hash: string;
    text_content: string;
    screenshot_path?: string | null;
  }): Snapshot {
    const info = this.db
      .prepare(
        `INSERT INTO snapshots (competitor_id, screenshot_path, html_hash, text_content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.competitor_id,
        input.screenshot_path ?? null,
        input.html_hash,
        input.text_content,
      );
    return this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Snapshot;
  }

  getSnapshotsByCompetitor(competitorId: number, limit = 50): Snapshot[] {
    return this.db
      .prepare(
        `SELECT * FROM snapshots WHERE competitor_id = ?
          ORDER BY captured_at DESC, id DESC LIMIT ?`,
      )
      .all(competitorId, limit) as Snapshot[];
  }

  getLatestSnapshot(competitorId: number): Snapshot | undefined {
    return this.db
      .prepare(
        `SELECT * FROM snapshots WHERE competitor_id = ?
          ORDER BY captured_at DESC, id DESC LIMIT 1`,
      )
      .get(competitorId) as Snapshot | undefined;
  }

  /* -------------------------------------------------------------------------
   * Changes
   * ---------------------------------------------------------------------- */

  addChange(input: {
    snapshot_id: number;
    previous_snapshot_id?: number | null;
    change_type: ChangeType;
    description: string;
    confidence?: number;
    verified?: boolean;
    desktop_screenshot_path?: string | null;
  }): Change {
    const info = this.db
      .prepare(
        `INSERT INTO changes
           (snapshot_id, previous_snapshot_id, change_type, description,
            confidence, verified, desktop_screenshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.snapshot_id,
        input.previous_snapshot_id ?? null,
        input.change_type,
        input.description,
        input.confidence ?? 0,
        input.verified ? 1 : 0,
        input.desktop_screenshot_path ?? null,
      );
    return this.db
      .prepare("SELECT * FROM changes WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Change;
  }

  /**
   * Changes, newest first. `competitorId` filters through the snapshot the
   * change was detected on.
   */
  getChanges(
    options: {
      competitorId?: number;
      minConfidence?: number;
      verifiedOnly?: boolean;
      limit?: number;
    } = {},
  ): Change[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.competitorId !== undefined) {
      clauses.push(
        "snapshot_id IN (SELECT id FROM snapshots WHERE competitor_id = ?)",
      );
      params.push(options.competitorId);
    }
    if (options.minConfidence !== undefined) {
      clauses.push("confidence >= ?");
      params.push(options.minConfidence);
    }
    if (options.verifiedOnly) clauses.push("verified = 1");

    params.push(options.limit ?? 50);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare(
        `SELECT * FROM changes ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Change[];
  }

  /* -------------------------------------------------------------------------
   * Alerts
   * ---------------------------------------------------------------------- */

  addAlert(input: {
    change_id: number;
    summary: string;
    severity?: Severity;
  }): Alert {
    const info = this.db
      .prepare("INSERT INTO alerts (change_id, summary, severity) VALUES (?, ?, ?)")
      .run(input.change_id, input.summary, input.severity ?? "medium");
    return this.db
      .prepare("SELECT * FROM alerts WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Alert;
  }

  getAlerts(options: { unreadOnly?: boolean; limit?: number } = {}): Alert[] {
    const where = options.unreadOnly ? "WHERE read_status = 0" : "";
    return this.db
      .prepare(
        `SELECT * FROM alerts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(options.limit ?? 50) as Alert[];
  }

  /** Returns false when no alert has that id. */
  markAlertRead(id: number): boolean {
    return (
      this.db.prepare("UPDATE alerts SET read_status = 1 WHERE id = ?").run(id)
        .changes > 0
    );
  }
}

const db = new ApertureDatabase();
export default db;
