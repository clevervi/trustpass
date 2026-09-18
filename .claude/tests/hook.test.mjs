import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readState } from "../scripts/tp-state.mjs";

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLAUDE_DIR, "..");
const HOOK = join(CLAUDE_DIR, "hooks", "route-read.mjs");

let stateDir;
let cacheDir;

/**
 * Runs the real hook the way Claude Code runs it: a fresh process, the payload
 * on stdin, the decision on stdout.
 *
 * Nothing is stubbed. If this passes, the thing that ships works — which is the
 * difference between this file and the three beside it.
 */
function runHook(payload, env = {}) {
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      TP_STATE_DIR: stateDir,
      TP_CACHE_DIR: cacheDir,
      // Absent unless a test puts it back. Every case below therefore runs with
      // Gemini switched off, which is the point: the router has to work anyway.
      GEMINI_API_KEY: "",
      ...env,
    },
  });

  return stdout.trim();
}

function decisionOf(stdout) {
  if (stdout.length === 0) {
    return { permissionDecision: null };
  }

  return JSON.parse(stdout).hookSpecificOutput;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tp-hook-state-"));
  cacheDir = mkdtempSync(join(tmpdir(), "tp-hook-cache-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("the hook, run as a process", () => {
  it("says nothing about a tool that is not Read", () => {
    assert.equal(runHook({ tool_name: "Bash", tool_input: { command: "ls" } }), "");
  });

  it("says nothing when stdin is not JSON at all", () => {
    // Somebody running it by hand, or a payload shape that changed. Not a
    // reason to interfere with a tool call.
    const stdout = execFileSync(process.execPath, [HOOK], {
      input: "this is not json",
      encoding: "utf8",
      env: { ...process.env, TP_STATE_DIR: stateDir, TP_CACHE_DIR: cacheDir },
    });

    assert.equal(stdout.trim(), "");
  });

  it("says nothing when stdin is empty", () => {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, TP_STATE_DIR: stateDir, TP_CACHE_DIR: cacheDir },
    });

    assert.equal(stdout.trim(), "");
  });

  it("lets a bounded read through, so verification always reaches the real file", () => {
    const stdout = runHook({
      tool_name: "Read",
      tool_input: {
        file_path: join(
          REPO_ROOT,
          "packages/db/src/repositories/product-status-repository.integration.test.ts",
        ),
        offset: 100,
        limit: 60,
      },
    });

    assert.equal(stdout, "");
    assert.equal(readState(stateDir).direct_reads, 1);
  });

  it("lets a migration through however large it is", () => {
    const stdout = runHook({
      tool_name: "Read",
      tool_input: {
        file_path: join(REPO_ROOT, "packages/db/drizzle/0024_three_roles_one_database.sql"),
      },
    });

    assert.equal(stdout, "", "a migration was delegated");
  });

  it("lets an ADR through", () => {
    const stdout = runHook({
      tool_name: "Read",
      tool_input: {
        file_path: join(
          REPO_ROOT,
          "docs/adr/0013-the-application-cannot-remove-its-own-guarantees.md",
        ),
      },
    });

    assert.equal(stdout, "");
  });

  it("never touches a file outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "tp-outside-"));

    try {
      const stdout = runHook({ tool_name: "Read", tool_input: { file_path: outside } });
      assert.equal(stdout, "");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces a large bulk file with a map, with no API key and no network", () => {
    // The whole point, demonstrated end to end: Gemini is switched off in this
    // process and the delegation still happens, because a test file is a list
    // of similarly shaped things and the local extractor is enough for that.
    const target = join(
      REPO_ROOT,
      "packages/db/src/repositories/product-status-repository.integration.test.ts",
    );
    const decision = decisionOf(runHook({ tool_name: "Read", tool_input: { file_path: target } }));

    assert.equal(decision.permissionDecision, "deny");
    assert.equal(decision.hookEventName, "PreToolUse");

    const reason = decision.permissionDecisionReason;

    // Absolute, because that is what the Read tool takes.
    assert.match(reason, /Read this instead: \S+\.md/);
    assert.match(reason, /SHA-256/);
    // The sentence that keeps a map from being mistaken for the territory.
    assert.match(reason, /navigation, not authority/);
    assert.match(reason, /offset and a limit/);

    const contextPath = reason.match(/Read this instead: (\S+)/)[1];
    assert.ok(isAbsolute(contextPath), `the path handed to Claude is not absolute: ${contextPath}`);
    assert.ok(
      existsSync(contextPath),
      `the context file named in the reason does not exist: ${contextPath}`,
    );

    const body = readFileSync(contextPath, "utf8");

    assert.match(body, /# Context map:/);
    assert.match(body, /Navigation only/);
    assert.match(body, /Produced by: local extractor/);
    assert.match(body, /\| Line \| Kind \| Symbol \|/);

    const state = readState(stateDir);

    assert.equal(state.delegated, 1);
    assert.equal(state.requests, 0, "Gemini was called with no key");
    assert.ok(state.estimated_tokens_saved > 0);
  });

  it("gets out of the way when the same full read is asked for again", () => {
    // The loop guard. If the map did not answer the question, serving it a
    // second time answers it no better and stops the work.
    const target = join(
      REPO_ROOT,
      "packages/db/src/repositories/product-status-repository.integration.test.ts",
    );
    const payload = { tool_name: "Read", tool_input: { file_path: target } };

    assert.equal(decisionOf(runHook(payload)).permissionDecision, "deny");
    assert.equal(runHook(payload), "", "the same read was denied twice");
  });

  it("falls back to a direct read when the budget is spent", () => {
    const target = join(REPO_ROOT, "apps/web/app/trustpass/[trustpassId]/page.tsx");

    if (!existsSync(target)) {
      return;
    }

    const stdout = runHook(
      { tool_name: "Read", tool_input: { file_path: target } },
      { GEMINI_API_KEY: "not-a-real-key", TP_GEMINI_DAILY_BUDGET: "0" },
    );

    // Budget spent means no call and no delegation for a file the local
    // extractor is not trusted with. Claude reads it, which is fine.
    assert.equal(stdout, "");
    assert.equal(readState(stateDir).requests, 0);
  });
});
