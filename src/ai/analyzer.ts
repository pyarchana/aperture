import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { Change, Competitor, Target } from "../db.js";

/**
 * Triage layer for detected changes: turns a raw diff into a scored,
 * categorized, human-readable finding that the alert rules can act on.
 */

export const ChangeAnalysisSchema = z.object({
  significance: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe("0 = cosmetic noise, 10 = major strategic move"),
  category: z.enum([
    "pricing",
    "product",
    "positioning",
    "hiring",
    "docs",
    "legal",
    "noise",
  ]),
  summary: z.string().describe("One sentence, under 140 characters"),
  details: z.string().describe("2-4 sentences on what changed and why it matters"),
  alert_worthy: z.boolean(),
});

export type ChangeAnalysis = z.infer<typeof ChangeAnalysisSchema>;

const SYSTEM_PROMPT = `You are a competitive intelligence analyst.

You receive diffs of a competitor's monitored surfaces (marketing pages,
pricing pages, docs, changelogs, app screens). Score how much each change
matters to a product team competing with them.

Guidance:
- Boilerplate churn - cookie banners, rotating testimonials, build hashes,
  copyright years, reordered nav - is category "noise" with significance 0-1.
- Price changes, new or removed plans/tiers/limits, new product surfaces, and
  repositioned messaging are the highest-value signals.
- Set alert_worthy only when a competent PM would want to know this week.
- Be specific about concrete values (old price vs new price). Do not speculate
  beyond what the diff shows.`;

/** Diffs beyond this are trimmed; the trim is disclosed in the prompt. */
const MAX_DIFF_CHARS = 60_000;

let client: Anthropic | null = null;

/**
 * Lazily constructs the client so dotenv only needs to be loaded before the
 * first analysis, not before this module is imported.
 */
function getClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("CLAUDE_API_KEY is not set - cannot analyze changes.");
  }

  client = new Anthropic({ apiKey });
  return client;
}

function buildPrompt(
  change: Pick<Change, "diff">,
  target: Pick<Target, "kind" | "locator" | "label">,
  competitor: Pick<Competitor, "name">,
): string {
  let diff = change.diff;
  let notice = "";

  if (diff.length > MAX_DIFF_CHARS) {
    console.warn(
      `[analyzer] diff is ${diff.length} chars; sending the first ${MAX_DIFF_CHARS}.`,
    );
    diff = diff.slice(0, MAX_DIFF_CHARS);
    notice =
      "\n\nNOTE: this diff was truncated for length. Score only what is shown " +
      "and say so in `details` if the truncation limits your confidence.";
  }

  return [
    `Competitor: ${competitor.name}`,
    `Surface: ${target.label ?? target.locator} (${target.kind})`,
    "",
    "Diff (unified, - = removed, + = added):",
    "```diff",
    diff,
    "```",
    notice,
  ].join("\n");
}

/**
 * Analyzes one detected change.
 *
 * Throws on API failure so the caller can decide whether to retry or leave the
 * change unanalyzed for the next scheduler pass.
 */
export async function analyzeChange(
  change: Pick<Change, "diff">,
  target: Pick<Target, "kind" | "locator" | "label">,
  competitor: Pick<Competitor, "name">,
): Promise<ChangeAnalysis> {
  const model = process.env.ANALYZER_MODEL ?? "claude-opus-5";

  try {
    const response = await getClient().messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: zodOutputFormat(ChangeAnalysisSchema),
      },
      messages: [
        { role: "user", content: buildPrompt(change, target, competitor) },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error(
        `Analyzer request was declined (${response.stop_details?.category ?? "unknown"}).`,
      );
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("Analyzer returned no parseable structured output.");
    }
    return parsed;
  } catch (error) {
    // Most specific first - the caller cares whether a retry could succeed.
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error("CLAUDE_API_KEY was rejected by the Claude API.");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error("Rate limited by the Claude API - retry on the next pass.");
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new Error(`Could not reach the Claude API: ${error.message}`);
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Claude API error ${error.status}: ${error.message}`);
    }
    throw error;
  }
}
