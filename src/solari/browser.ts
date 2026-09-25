import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Solari } from "@solarisdk/browser";

export interface ScrapeResult {
  /** Path of the saved screenshot, relative to cwd, with forward slashes. */
  screenshotPath: string;
  /** sha256 of the page HTML. */
  htmlHash: string;
  /** Visible text from document.body. */
  textContent: string;
  /**
   * Presigned replay URL for the session recording. Null when the replay was
   * not ready in time - the gateway needs a moment after release to publish
   * it, and a missing recording is not worth failing an otherwise good scrape.
   */
  sessionRecordingUrl: string | null;
}

const NAV_TIMEOUT_MS = 45_000;
const SNAPSHOT_ROOT = "snapshots";
/** getReplayUrl becomes available ~1-3s after the session is released. */
const REPLAY_ATTEMPTS = 5;
const REPLAY_RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserAgent {
  private readonly apiKey: string;

  constructor(options: { apiKey: string }) {
    if (!options.apiKey) throw new Error("BrowserAgent requires an apiKey.");
    this.apiKey = options.apiKey;
  }

  /**
   * Captures one page: screenshot, visible text, and a hash of the HTML.
   *
   * A Solari client is created and closed per scrape. The client owns a local
   * proxy that keeps the event loop alive, so `solari.close()` in the finally
   * block is what stops the process from hanging on exit - it runs on the
   * error path too.
   */
  async scrape(url: string, competitorId: number): Promise<ScrapeResult> {
    const solari = new Solari({ apiKey: this.apiKey });
    let browser: Awaited<ReturnType<Solari["launch"]>> | undefined;

    try {
      // captcha and proxy both require stealth, per the SDK's option docs.
      browser = await solari.launch({
        stealth: true,
        proxy: "us",
        captcha: true,
        recording: true,
      });

      // Captured before close(), which is what makes the replay retrievable.
      const sessionId = browser.id;

      const page = await browser.newPage();
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT_MS,
      });

      const html = await page.content();
      const textContent = await page.innerText("body");
      const png = await page.screenshot({ fullPage: true, type: "png" });

      const screenshotPath = await this.saveScreenshot(competitorId, png);

      // Release first: the replay is only published once the session ends.
      await browser.close();
      browser = undefined;

      const sessionRecordingUrl = await this.fetchRecordingUrl(solari, sessionId);

      return {
        screenshotPath,
        htmlHash: crypto.createHash("sha256").update(html, "utf8").digest("hex"),
        textContent,
        sessionRecordingUrl,
      };
    } catch (error) {
      throw new Error(
        `Scrape of ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      // close() is idempotent, so the success path having already closed the
      // browser is fine. Failures here must not mask the original error.
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      await solari.close().catch(() => undefined);
    }
  }

  /** Writes the PNG to ./snapshots/{competitorId}/{timestamp}.png. */
  private async saveScreenshot(
    competitorId: number,
    png: Buffer,
  ): Promise<string> {
    const dir = path.join(SNAPSHOT_ROOT, String(competitorId));
    await fs.mkdir(dir, { recursive: true });

    // ':' and '.' are illegal in Windows filenames, so flatten the timestamp.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}.png`);
    await fs.writeFile(file, png);

    // Forward slashes so the stored path is portable across platforms.
    return file.split(path.sep).join("/");
  }

  /**
   * Polls for the session replay URL. Returns null rather than throwing - the
   * screenshot and text are the payload, and losing the recording should not
   * discard them.
   */
  private async fetchRecordingUrl(
    solari: Solari,
    sessionId: string,
  ): Promise<string | null> {
    // close() already released the session; this just confirms it landed.
    await solari.sessions.releaseAndWait(sessionId).catch(() => undefined);

    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      try {
        const replay = await solari.sessions.getReplayUrl(sessionId);
        if (replay.url) return replay.url;
      } catch {
        // Not published yet - fall through and retry.
      }
      await sleep(REPLAY_RETRY_MS);
    }

    console.warn(
      `[solari/browser] replay URL for session ${sessionId} was not ready after ` +
        `${(REPLAY_ATTEMPTS * REPLAY_RETRY_MS) / 1000}s.`,
    );
    return null;
  }
}

export default BrowserAgent;
