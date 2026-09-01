import { SandboxClient } from "@solarisdk/sandbox";

import type { CaptureResult } from "./browser.js";
import { sha256, solariApiKey, solariBaseUrl } from "./browser.js";

/**
 * Solari Sandbox: ephemeral compute for work that should not run in the API
 * process - executing a competitor's downloaded build, running an untrusted
 * extraction script over a captured page, or probing a public CLI/installer.
 */

export interface SandboxRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Idle window before the gateway auto-releases an abandoned sandbox. */
const SANDBOX_TTL_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

let client: SandboxClient | null = null;

function getClient(): SandboxClient {
  if (client) return client;
  client = new SandboxClient({ apiKey: solariApiKey(), baseUrl: solariBaseUrl() });
  return client;
}

/**
 * Runs a shell command inside a fresh ephemeral sandbox and disposes it.
 *
 * The guest runs `cmd` directly rather than through a shell, so the command is
 * handed to `sh -c` to keep pipes and redirection working.
 */
export async function runInSandbox(
  command: string,
  options: { timeoutMs?: number; template?: string } = {},
): Promise<SandboxRun> {
  const sandbox = await getClient().create({
    template: options.template ?? "base",
    timeoutMs: SANDBOX_TTL_MS,
  });

  try {
    await sandbox.connect();
    const result = await sandbox.commands.run("sh", {
      args: ["-c", command],
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } finally {
    // Releases the remote session; without this it lingers until the TTL.
    await sandbox.kill();
  }
}

/**
 * Captures a target by running an extraction command in a sandbox and
 * treating its stdout as the diffable surface.
 */
export async function captureViaSandbox(command: string): Promise<CaptureResult> {
  const run = await runInSandbox(command);
  if (run.exitCode !== 0) {
    throw new Error(
      `Sandbox command exited ${run.exitCode}: ${run.stderr.slice(0, 500)}`,
    );
  }

  const text = run.stdout.trim();
  return {
    text,
    hash: sha256(text),
    raw: run.stdout,
    extension: "txt",
    source: "solari-sandbox",
  };
}
