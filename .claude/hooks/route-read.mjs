#!/usr/bin/env node
/**
 * The PreToolUse hook. Everything that can go wrong here ends with the `Read`
 * happening normally.
 *
 * That is not defensiveness for its own sake. A hook is in the path of every
 * file this session opens, and the worst possible failure mode is one where a
 * broken optimisation makes the work impossible rather than merely more
 * expensive. Claude Code helps: a hook that times out does **not** block, and a
 * hook that exits non-zero without printing a decision does not block either.
 * So the safe outcome is also the default one, and every `return` below that is
 * not an explicit deny reaches it.
 *
 * Contract, verified against the documentation before any of this was written:
 *
 *   stdin   { tool_name, tool_input: { file_path, offset, limit }, cwd, ... }
 *   stdout  { hookSpecificOutput: { hookEventName, permissionDecision,
 *                                   permissionDecisionReason } }
 *   exit 0  the JSON is honoured
 *
 * The reason text reaches Claude. Without that fact the whole design is
 * impossible, which is why it was checked first rather than assumed.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheKey,
  EXTRACTOR_VERSION,
  estimateTokens,
  extractionIsSufficient,
  extractLocally,
  readCache,
  renderContext,
  sha256,
  writeCache,
  writeContext,
} from "../scripts/tp-context.mjs";
import { analyse, DEFAULT_MODEL, PROMPT_VERSION, THINKING_LEVELS } from "../scripts/tp-gemini.mjs";
import { decideRoute, loadPolicy, ROUTER_VERSION } from "../scripts/tp-router.mjs";
import {
  bump,
  closeCircuit,
  FAILURE_PERMANENT,
  geminiAvailability,
  openCircuit,
  readState,
  updateState,
} from "../scripts/tp-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(CLAUDE_DIR, "..");

// Overridable so the integration tests can run the real hook against real
// files without writing into the state a working session is using. Not a
// classification seam — TP_REPO_ROOT is deliberately absent, because an
// environment variable that moves the repository boundary is an environment
// variable that moves what counts as "outside the repository".
const STATE_DIR = process.env.TP_STATE_DIR || join(CLAUDE_DIR, ".state");

const DIRS = {
  state: STATE_DIR,
  cache: process.env.TP_CACHE_DIR || join(CLAUDE_DIR, "cache"),
  context: join(STATE_DIR, "context"),
  policy: join(CLAUDE_DIR, "context", "sensitive-paths.txt"),
};

const CONFIG = {
  model: process.env.TP_GEMINI_MODEL || DEFAULT_MODEL,
  apiKey: process.env.GEMINI_API_KEY || null,
  dailyBudget: Number(process.env.TP_GEMINI_DAILY_BUDGET || 25),
  timeoutMs: Number(process.env.TP_GEMINI_TIMEOUT_SECONDS || 8) * 1000,
  maxRetries: Number(process.env.TP_GEMINI_MAX_RETRIES || 1),
  cooldownSeconds: Number(process.env.TP_GEMINI_FAILURE_COOLDOWN_SECONDS || 300),
  // `low`, because this is an extraction job and not a reasoning one.
  //
  // #133 shipped this unset, with a comment saying the documentation showed
  // `minimal` and that neither value could be checked. The comment was wrong:
  // it came from an example on another page. The model's own documentation
  // says `low`, `medium` (the default) and `high` are supported, and that
  // **`minimal` is not supported for Gemini 3.8 Flash and will return an
  // error** — so the review that asked for `low` was right, and the
  // uncertainty that justified sending nothing did not exist.
  //
  // `low` is documented for latency-critical work. Reading a file and listing
  // what is in it is that; `medium` would buy reasoning this deliberately does
  // not want the model doing.
  thinkingLevel: process.env.TP_GEMINI_THINKING_LEVEL || "low",
  /** A repeat of the same delegated read inside this window is let through. */
  loopWindowMs: 60_000,
};

// A value outside the allowlist is dropped by tp-gemini, which is the safe
// behaviour and a silent one: TP_GEMINI_THINKING_LEVEL=banana would look like
// it took. stderr, because stdout carries the decision and nothing else.
if (CONFIG.thinkingLevel && !THINKING_LEVELS.has(CONFIG.thinkingLevel)) {
  process.stderr.write(
    `tp-router: TP_GEMINI_THINKING_LEVEL="${CONFIG.thinkingLevel}" is not one of ` +
      `${[...THINKING_LEVELS].join(", ")}. Ignoring it; the API default applies.
`,
  );
}

function passthrough() {
  // Silence and exit 0. Printing an explicit "allow" would be worse: it would
  // override a deny from another hook that had a better reason than this one.
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function sizeOf(path) {
  try {
    const bytes = statSync(path).size;

    // Reading the file to count lines costs exactly what the hook is trying to
    // avoid — but only inside this short-lived process, and only once, and the
    // result decides whether the model reads it too.
    const lines = readFileSync(path, "utf8").split(/\r?\n/).length;

    return { bytes, lines };
  } catch {
    return null;
  }
}

function denialMessage({ relativePath, sourceSha256, contextPath, origin }) {
  return [
    `Reading all of ${relativePath} was replaced with a context map (${origin}).`,
    "",
    // Absolute, because that is what the Read tool takes. The first version of
    // this gave a repository-relative path, which reads fine to a human and
    // sends the tool looking in the wrong place — caught by the integration
    // test running with the state directory somewhere else, where the relative
    // form came out as `../../AppData/Local/Temp/...`.
    `Read this instead: ${contextPath}`,
    "",
    `It names the symbols in the file and where each one starts. SHA-256 of the`,
    `source is ${sourceSha256}.`,
    "",
    "It is navigation, not authority. When the change depends on what the code",
    "actually does, read the specific lines: a Read with an offset and a limit of",
    "180 lines or fewer is never routed through here and always reaches the real",
    "file.",
  ].join("\n");
}

async function main() {
  const raw = readStdin();

  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    // Anything unparseable, including empty stdin, is somebody calling this by
    // hand or a contract that changed. Not our business, and not a reason to
    // interfere with a tool call.
    return passthrough();
  }

  if (!payload || typeof payload !== "object") {
    return passthrough();
  }

  const request = {
    toolName: payload.tool_name,
    filePath: payload.tool_input?.file_path,
    offset: payload.tool_input?.offset,
    limit: payload.tool_input?.limit,
  };

  if (request.toolName !== "Read") {
    return passthrough();
  }

  bump(DIRS.state, "reads");

  const policy = loadPolicy((path) => readFileSync(path, "utf8"), DIRS.policy);
  const decision = decideRoute(request, { repoRoot: REPO_ROOT, policy, sizeOf });

  if (decision.action !== "delegate") {
    bump(DIRS.state, "direct_reads");
    return passthrough();
  }

  bump(DIRS.state, "delegated_candidates");

  let source;

  try {
    source = readFileSync(decision.realPath, "utf8");
  } catch {
    return passthrough();
  }

  const relativePath = relative(REPO_ROOT, decision.realPath).split(sep).join("/");
  const sourceSha256 = sha256(source);
  const key = cacheKey({
    sourceSha256,
    model: CONFIG.model,
    promptVersion: PROMPT_VERSION,
    routerVersion: ROUTER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
  });

  const state = readState(DIRS.state);

  // The loop guard. If this exact file was just replaced with a map and the
  // full read is being asked for again, the map did not answer the question —
  // so get out of the way rather than serving the same map a second time.
  if (
    state.last_denied?.key === key &&
    Date.now() - (state.last_denied.at ?? 0) < CONFIG.loopWindowMs
  ) {
    bump(DIRS.state, "direct_reads");
    return passthrough();
  }

  const extraction = extractLocally(source);

  const serve = (analysis, origin) => {
    const body = renderContext({
      relativePath,
      sourceSha256,
      totalLines: extraction.totalLines,
      origin,
      analysis,
      extraction,
    });

    const contextPath = writeContext(DIRS.context, key, body);

    updateState(DIRS.state, (current) => ({
      ...current,
      delegated: (current.delegated ?? 0) + 1,
      estimated_tokens_saved:
        (current.estimated_tokens_saved ?? 0) +
        Math.max(0, estimateTokens(source) - estimateTokens(body)),
      last_denied: { key, at: Date.now() },
    }));

    deny(denialMessage({ relativePath, sourceSha256, contextPath, origin }));
  };

  const cached = readCache(DIRS.cache, key);

  // Before the budget, before the circuit, before anything about Gemini being
  // reachable. A summary already paid for does not need it to be.
  if (cached?.analysis) {
    bump(DIRS.state, "cache_hits");
    return serve(cached.analysis, "cache");
  }

  if (extractionIsSufficient({ level: decision.level, extraction })) {
    return serve(null, "local extractor");
  }

  const availability = geminiAvailability(readState(DIRS.state), {
    dailyBudget: CONFIG.dailyBudget,
  });

  if (!availability.available) {
    bump(DIRS.state, "fallbacks");
    return passthrough();
  }

  bump(DIRS.state, "requests");

  const result = await analyse({
    source,
    relativePath,
    sha256: sourceSha256,
    totalLines: extraction.totalLines,
    apiKey: CONFIG.apiKey,
    model: CONFIG.model,
    thinkingLevel: CONFIG.thinkingLevel,
    timeoutMs: CONFIG.timeoutMs,
    maxRetries: CONFIG.maxRetries,
  });

  if (!result.ok) {
    // Permanent means asking again produces the same answer, so stop asking for
    // a while. Transient means the retry inside `analyse` already happened and
    // also failed, which is the same conclusion by a different route.
    openCircuit(DIRS.state, {
      reason: `${result.kind === FAILURE_PERMANENT ? "permanent" : "transient"}: ${result.reason}`,
      cooldownSeconds: CONFIG.cooldownSeconds,
    });
    bump(DIRS.state, "fallbacks");
    return passthrough();
  }

  closeCircuit(DIRS.state);

  updateState(DIRS.state, (current) => ({
    ...current,
    estimated_input_tokens:
      (current.estimated_input_tokens ?? 0) + (result.usage?.inputTokens ?? 0),
    estimated_output_tokens:
      (current.estimated_output_tokens ?? 0) + (result.usage?.outputTokens ?? 0),
  }));

  writeCache(DIRS.cache, key, {
    source_path: relativePath,
    source_sha256: sourceSha256,
    model: CONFIG.model,
    prompt_version: PROMPT_VERSION,
    router_version: ROUTER_VERSION,
    extractor_version: EXTRACTOR_VERSION,
    generated_at: new Date().toISOString(),
    analysis: result.analysis,
  });

  return serve(result.analysis, `${CONFIG.model}`);
}

main().catch(() => {
  // The last net. Whatever it was, it is not worth a failed Read.
  passthrough();
});
