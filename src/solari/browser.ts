import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Solari } from "@solarisdk/browser";

/**
 * Result of capturing one target surface.
 *
 * Declared here (rather than in a separate types module) because the browser
 * is the primary capture surface; `sandbox.ts` and `desktop.ts` import it.
 */
export interface CaptureResult {
  /** Normalized, diffable text. This is what change detection compares. */
  text: string;
  /** sha256 of `text`. */
  hash: string;
  /**
   * The raw capture (html, stdout, png bytes). Deliberately NOT written to
   * disk here: most captures find no change and are discarded, and writing
   * eagerly would leave an orphaned file behind on every unchanged run. The
   * scheduler persists this only when it actually records a snapshot.
   */
  raw: string | Uint8Array;
  /** File extension for `raw`, used when it is persisted. */
  extension: string;
  /** Which capture path produced this result. */
  source: "solari-browser" | "fetch-fallback" | "solari-sandbox" | "solari-desktop";
}

/** Thrown when SOLARI_API_KEY is missing, so callers can decide how to degrade. */
export class SolariNotConfiguredError extends Error {
  constructor() {
    super("SOLARI_API_KEY is not set.");
    this.name = "SolariNotConfiguredError";
  }
}

export function solariApiKey(): string {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) throw new SolariNotConfiguredError();
  return apiKey;
}

/** Gateway base URL, required by the sandbox and desktop clients. */
export function solariBaseUrl(): string {
  return process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com";
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function snapshotDir(): string {
  return path.resolve(process.env.SNAPSHOT_DIR ?? "./snapshots");
}

/** Writes a raw artifact under SNAPSHOT_DIR and returns its relative path. */
export async function writeArtifact(
  targetId: number,
  extension: string,
  data: string | Uint8Array,
): Promise<string> {
  const relDir = path.join(String(targetId));
  const absDir = path.join(snapshotDir(), relDir);
  await fs.mkdir(absDir, { recursive: true });

  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  await fs.writeFile(path.join(absDir, name), data);
  // Stored with forward slashes so the path stays portable across platforms.
  return path.posix.join(relDir, name);
}

/**
 * Collapses HTML into diff-friendly text: scripts and styles dropped, tags
 * stripped, entities decoded, whitespace normalized. Keeps diffs about
 * content rather than markup churn.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

/* ---------------------------------------------------------------------------
 * Solari adapter
 *
 * @solarisdk/browser hands back a Playwright-compatible browser over a remote
 * session, so navigation and content extraction are ordinary Playwright calls.
 * ------------------------------------------------------------------------ */

const NAV_TIMEOUT_MS = 45_000;

let solari: Solari | null = null;

function getSolari(): Solari {
  if (solari) return solari;
  solari = new Solari({ apiKey: solariApiKey() });
  return solari;
}

/** Releases the shared Solari client. Called on shutdown. */
export async function closeSolari(): Promise<void> {
  await solari?.close();
  solari = null;
}

/**
 * Renders `url` in a Solari browser session and returns its final HTML.
 *
 * `stealth` is on because competitor marketing sites routinely bot-block
 * datacenter IPs; without it captures come back as challenge pages.
 */
async function renderWithSolari(url: string): Promise<string> {
  const browser = await getSolari().launch({ stealth: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    return await page.content();
  } finally {
    // Closes the browser and releases the remote session.
    await browser.close();
  }
}

/** Last-resort capture so the pipeline is runnable without a Solari key. */
async function fetchFallback(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "aperture/0.1 (competitive monitoring)" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Captures a web target.
 *
 * Prefers the Solari browser, which executes JavaScript - most competitor
 * pricing and marketing pages are client-rendered, and a raw fetch of those
 * returns an empty shell that diffs as "no change" forever. Falls back to
 * fetch only when no Solari key is configured.
 *
 * Both paths run the same htmlToText normalization, so switching between them
 * does not manufacture a spurious full-page diff.
 */
export async function captureWeb(url: string): Promise<CaptureResult> {
  let html: string;
  let source: CaptureResult["source"] = "solari-browser";

  try {
    html = await renderWithSolari(url);
  } catch (error) {
    if (!(error instanceof SolariNotConfiguredError)) throw error;
    console.warn(
      "[solari/browser] SOLARI_API_KEY is not set - falling back to fetch(). " +
        "Client-rendered pages will capture as empty shells.",
    );
    html = await fetchFallback(url);
    source = "fetch-fallback";
  }

  const text = htmlToText(html);
  return { text, hash: sha256(text), raw: html, extension: "html", source };
}
