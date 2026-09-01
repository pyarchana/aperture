import { DesktopClient } from "@solarisdk/desktop";

import type { CaptureResult } from "./browser.js";
import { sha256, solariApiKey, solariBaseUrl } from "./browser.js";

/**
 * Solari Desktop: managed virtual desktops driven through a computer-use
 * action API. Used for competitor surfaces that have no web equivalent -
 * installed desktop apps, native onboarding flows, licensing dialogs.
 */

/** Seconds before the gateway auto-releases the session. */
const DESKTOP_TTL_SECONDS = 300;
/** Time for the launched app to paint before the screenshot is taken. */
const APP_SETTLE_MS = 5_000;

let client: DesktopClient | null = null;

function getClient(): DesktopClient {
  if (client) return client;
  client = new DesktopClient({ apiKey: solariApiKey(), baseUrl: solariBaseUrl() });
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures a desktop target: launches `appLocator` on a fresh virtual desktop,
 * keeps the screenshot as the artifact, and derives the diffable text surface
 * from the guest's running processes and display geometry.
 *
 * Why not the screenshot itself: pixels move on every capture (clocks, cursor
 * position, antialiasing), so hashing the image would report a change on every
 * single run and burn an analyzer call each time. The process/window listing is
 * stable between runs and still moves when the app genuinely changes - a new
 * binary, a new helper process, a resized default window.
 *
 * The richer upgrade is OCR over the screenshot, or sending the image to a
 * vision model; both are a change to the analyzer, which today takes text
 * diffs only.
 */
export async function captureDesktop(appLocator: string): Promise<CaptureResult> {
  const desktop = await getClient().create({ ttlSeconds: DESKTOP_TTL_SECONDS });

  try {
    await desktop.connect();
    await desktop.open(appLocator);
    await sleep(APP_SETTLE_MS);

    const [size, processes, png] = await Promise.all([
      desktop.display.size(),
      desktop.process.list(),
      desktop.screenshot({ format: "png" }),
    ]);

    // pids are excluded deliberately - they change on every launch and would
    // make every capture look like a change.
    const surface = [
      `app: ${appLocator}`,
      `display: ${size.w}x${size.h}`,
      "processes:",
      ...[...new Set(processes.map((p) => `  ${p.name}\t${p.cmd ?? ""}`.trimEnd()))].sort(),
    ].join("\n");

    return {
      text: surface,
      hash: sha256(surface),
      raw: png,
      extension: "png",
      source: "solari-desktop",
    };
  } finally {
    // Releases the remote session; without this it lingers until the TTL.
    await desktop.kill();
  }
}
