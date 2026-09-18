#!/usr/bin/env node
/**
 * What the router did today.
 *
 * Every token number below is this script's own arithmetic over a
 * four-characters-per-token rule of thumb. It is not Anthropic's billing, not
 * Google's metering, and not a measurement of anything. It says so on the line
 * where it appears, because a number in a report is read as a fact unless it
 * argues otherwise.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readState, statePath } from "./tp-state.mjs";

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(CLAUDE_DIR, ".state");

function row(label, value) {
  return `  ${label.padEnd(30)} ${String(value)}`;
}

const state = readState(STATE_DIR);
const lines = [
  "",
  "TrustPass AI Context Router",
  `  ${state.date}`,
  "",
  row("Reads seen", state.reads),
  row("Read directly", state.direct_reads),
  row("Large candidates", state.delegated_candidates),
  row("Replaced with a map", state.delegated),
  "",
  row("Gemini calls", state.requests),
  row("Cache hits", state.cache_hits),
  row("Gemini failures", state.failures),
  row("Fell back to a direct read", state.fallbacks),
  "",
  row("Circuit", state.circuit_state),
];

if (state.circuit_reason) {
  lines.push(row("  because", state.circuit_reason));
}

if (state.circuit_until) {
  lines.push(row("  until", state.circuit_until));
}

lines.push(
  "",
  "  Estimated, by a 4-characters-per-token rule of thumb. Not billing.",
  row("  Input tokens to Gemini", state.estimated_input_tokens),
  row("  Output tokens from Gemini", state.estimated_output_tokens),
  row("  Tokens avoided in Claude", state.estimated_tokens_saved),
  "",
  `  State: ${statePath(STATE_DIR)}`,
  "",
);

process.stdout.write(`${lines.join("\n")}\n`);
