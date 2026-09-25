import "dotenv/config";

import { pathToFileURL } from "node:url";

import cron, { type ScheduledTask } from "node-cron";

import db, { type Competitor, type Snapshot } from "./db.js";
import BrowserAgent from "./solari/browser.js";

/** Every 6 hours, on the hour. */
const EVERY_SIX_HOURS = "0 */6 * * *";

export interface RunSummary {
  scraped: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
}

export class Scheduler {
  private readonly agent: BrowserAgent;
  private readonly expression: string;
  private task: ScheduledTask | null = null;
  /** Guards manual runAll() calls; cron ticks are guarded by noOverlap. */
  private inFlight = false;

  constructor(options: { apiKey?: string; cronExpression?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.SOLARI_API_KEY;
    if (!apiKey) {
      throw new Error("SOLARI_API_KEY is required to run the scheduler.");
    }

    this.expression = options.cronExpression ?? EVERY_SIX_HOURS;
    if (!cron.validate(this.expression)) {
      throw new Error(`Invalid cron expression: ${this.expression}`);
    }

    this.agent = new BrowserAgent({ apiKey });
  }

  /** Registers the cron task. Idempotent. */
  start(): void {
    if (this.task) return;

    this.task = cron.schedule(
      this.expression,
      () => {
        void this.runAll();
      },
      {
        name: "aperture-scrape",
        // A scrape run can outlast its window; skip the tick rather than stack.
        noOverlap: true,
        timezone: process.env.TZ ?? "UTC",
      },
    );

    console.log(`[scheduler] scheduled: ${this.expression} (${process.env.TZ ?? "UTC"})`);
  }

  async stop(): Promise<void> {
    await this.task?.stop();
    this.task = null;
  }

  /**
   * Scrapes every competitor, one at a time.
   *
   * Sequential on purpose: each scrape holds a remote browser session, and
   * running them in parallel trips Solari's concurrency limit. One competitor
   * failing must not abort the rest of the run.
   */
  async runAll(): Promise<RunSummary> {
    const startedAt = new Date().toISOString();

    if (this.inFlight) {
      console.warn("[scheduler] a run is already in progress - skipping.");
      return { scraped: 0, failed: 0, startedAt, finishedAt: startedAt };
    }
    this.inFlight = true;

    let scraped = 0;
    let failed = 0;

    try {
      const competitors = db.getCompetitors();
      console.log(`[scheduler] run started for ${competitors.length} competitor(s).`);

      for (const competitor of competitors) {
        try {
          await this.runCompetitor(competitor);
          scraped++;
        } catch (error) {
          failed++;
          console.error(
            `[scheduler] ${competitor.name} (id ${competitor.id}) failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } finally {
      this.inFlight = false;
    }

    const finishedAt = new Date().toISOString();
    console.log(`[scheduler] run finished - ${scraped} scraped, ${failed} failed.`);
    return { scraped, failed, startedAt, finishedAt };
  }

  /** Scrapes one competitor and stores the snapshot. */
  async runCompetitor(competitor: Competitor): Promise<Snapshot> {
    // Read before inserting: Phase 2 compares against this to build the diff.
    const previous = db.getLatestSnapshot(competitor.id);

    const result = await this.agent.scrape(competitor.url, competitor.id);

    const snapshot = db.addSnapshot({
      competitor_id: competitor.id,
      html_hash: result.htmlHash,
      text_content: result.textContent,
      screenshot_path: result.screenshotPath,
    });
    db.updateLastChecked(competitor.id);

    if (!previous) {
      console.log(`[scheduler] ${competitor.name}: baseline snapshot ${snapshot.id}.`);
    } else if (previous.html_hash === result.htmlHash) {
      console.log(`[scheduler] ${competitor.name}: unchanged.`);
    } else {
      console.log(`[scheduler] ${competitor.name}: content changed.`);
      // Phase 2 (step 8) hooks in here: run the sandbox diff over
      // previous.text_content vs result.textContent, and on a real change
      // create a Change plus an Alert.
    }

    return snapshot;
  }
}

export default Scheduler;

/* ---------------------------------------------------------------------------
 * Standalone entry point: `npm run scheduler`
 * ------------------------------------------------------------------------ */

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain) {
  const scheduler = new Scheduler();
  scheduler.start();

  // Run once at boot so a restart does not wait up to 6 hours for data.
  void scheduler.runAll();

  const shutdown = (signal: string): void => {
    console.log(`[scheduler] ${signal} received, stopping.`);
    void scheduler.stop().finally(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
