import cron from "node-cron";

import { analyzeChange } from "./ai/analyzer.js";
import {
  createAlert,
  getCompetitor,
  insertChange,
  insertSnapshot,
  latestSnapshot,
  listCompetitors,
  listTargets,
  saveAnalysis,
  type Change,
  type Target,
} from "./db.js";
import { captureWeb, writeArtifact, type CaptureResult } from "./solari/browser.js";
import { captureDesktop } from "./solari/desktop.js";
import { captureViaSandbox } from "./solari/sandbox.js";

const DEFAULT_CRON = "0 */6 * * *";
const DEFAULT_ALERT_THRESHOLD = 5;

/**
 * One cron task per competitor, keyed by competitor id. The task type is
 * derived from `cron.schedule` so it stays correct across node-cron versions.
 */
const tasks = new Map<number, ReturnType<typeof cron.schedule>>();
/** Guards against a slow run overlapping its own next tick. */
const inFlight = new Set<number>();

/* ---------------------------------------------------------------------------
 * Diffing
 * ------------------------------------------------------------------------ */

/**
 * Block diff: trims the common prefix and suffix, then reports the changed
 * middle as removed lines followed by added lines, with a little context.
 *
 * Not a line-by-line LCS - for monitoring "what part of this page changed"
 * a block diff is enough and stays linear in the size of the page.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }

  const removed = a.slice(start, a.length - end);
  const added = b.slice(start, b.length - end);
  if (removed.length === 0 && added.length === 0) return "";

  const lead = a.slice(Math.max(0, start - context), start);
  const trail = a.slice(a.length - end, a.length - end + context);

  return [
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...lead.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trail.map((line) => ` ${line}`),
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * Pipeline
 * ------------------------------------------------------------------------ */

function capture(target: Target): Promise<CaptureResult> {
  switch (target.kind) {
    case "web":
      return captureWeb(target.locator);
    case "app":
      return captureViaSandbox(target.locator);
    case "desktop":
      return captureDesktop(target.locator);
  }
}

/**
 * Persists a capture plus its raw artifact.
 *
 * The artifact is written here rather than during capture so that unchanged
 * captures - the large majority - leave nothing behind on disk.
 */
async function persist(target: Target, result: CaptureResult) {
  const artifactPath = await writeArtifact(
    target.id,
    result.extension,
    result.raw,
  );
  return insertSnapshot({
    target_id: target.id,
    content_hash: result.hash,
    text_content: result.text,
    artifact_path: artifactPath,
  });
}

function alertThreshold(): number {
  const raw = Number(process.env.ALERT_MIN_SIGNIFICANCE);
  return Number.isFinite(raw) ? raw : DEFAULT_ALERT_THRESHOLD;
}

/**
 * Captures one target and, if its content moved, records the change, analyzes
 * it, and raises an alert when it clears the significance threshold.
 *
 * Returns the recorded change, or null when nothing changed.
 */
export async function runTarget(target: Target): Promise<Change | null> {
  const result = await capture(target);
  const previous = latestSnapshot(target.id);

  // First capture establishes the baseline; there is nothing to diff against.
  if (!previous) {
    await persist(target, result);
    console.log(`[scheduler] baseline captured for target ${target.id}`);
    return null;
  }

  if (previous.content_hash === result.hash) return null;

  const diff = unifiedDiff(previous.text_content, result.text);
  if (diff === "") return null;

  const snapshot = await persist(target, result);

  const change = insertChange({
    target_id: target.id,
    from_snapshot_id: previous.id,
    to_snapshot_id: snapshot.id,
    diff,
  });

  const competitor = getCompetitor(target.competitor_id);
  if (!competitor) return change;

  // Analysis is best-effort: an unanalyzed change stays queued and is picked
  // up on the next pass rather than losing the detection.
  try {
    const analysis = await analyzeChange(change, target, competitor);
    saveAnalysis(change.id, analysis);

    if (analysis.alert_worthy && analysis.significance >= alertThreshold()) {
      createAlert({
        change_id: change.id,
        body: `[${competitor.name}] ${analysis.summary}\n\n${analysis.details}`,
      });
      console.log(
        `[scheduler] alert raised for ${competitor.name}: ${analysis.summary}`,
      );
    }
    return {
      ...change,
      significance: analysis.significance,
      category: analysis.category,
      summary: analysis.summary,
      details: analysis.details,
      analyzed_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error(
      `[scheduler] analysis failed for change ${change.id}:`,
      error instanceof Error ? error.message : error,
    );
    return change;
  }
}

/** Runs every enabled target belonging to one competitor, in sequence. */
export async function runCompetitor(competitorId: number): Promise<void> {
  if (inFlight.has(competitorId)) {
    console.warn(
      `[scheduler] competitor ${competitorId} is still running - skipping this tick.`,
    );
    return;
  }
  inFlight.add(competitorId);

  try {
    for (const target of listTargets(competitorId)) {
      if (!target.enabled) continue;
      try {
        await runTarget(target);
      } catch (error) {
        console.error(
          `[scheduler] target ${target.id} (${target.locator}) failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    inFlight.delete(competitorId);
  }
}

/* ---------------------------------------------------------------------------
 * Scheduling
 * ------------------------------------------------------------------------ */

/** Registers (or re-registers) the cron task for one competitor. */
export function scheduleCompetitor(competitorId: number): boolean {
  const competitor = getCompetitor(competitorId);
  if (!competitor) return false;

  tasks.get(competitorId)?.stop();
  tasks.delete(competitorId);

  if (!competitor.enabled) return false;

  const expression = competitor.cron ?? process.env.DEFAULT_CRON ?? DEFAULT_CRON;
  if (!cron.validate(expression)) {
    console.error(
      `[scheduler] competitor ${competitor.name} has an invalid cron expression: ${expression}`,
    );
    return false;
  }

  const task = cron.schedule(
    expression,
    () => {
      void runCompetitor(competitorId);
    },
    { timezone: process.env.TZ ?? "UTC" },
  );

  tasks.set(competitorId, task);
  console.log(`[scheduler] ${competitor.name} scheduled: ${expression}`);
  return true;
}

/** Schedules every competitor currently in the database. */
export function startScheduler(): void {
  for (const competitor of listCompetitors()) {
    scheduleCompetitor(competitor.id);
  }
  console.log(`[scheduler] ${tasks.size} competitor(s) scheduled.`);
}

export function unscheduleCompetitor(competitorId: number): void {
  tasks.get(competitorId)?.stop();
  tasks.delete(competitorId);
}

export function stopScheduler(): void {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}
