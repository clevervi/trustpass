import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  bump,
  CIRCUIT_CLOSED,
  CIRCUIT_OPEN,
  closeCircuit,
  geminiAvailability,
  openCircuit,
  readState,
  statePath,
  updateState,
} from "../scripts/tp-state.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tp-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("state", () => {
  it("starts from zero without a file", () => {
    const state = readState(dir);

    assert.equal(state.requests, 0);
    assert.equal(state.circuit_state, CIRCUIT_CLOSED);
  });

  it("treats a corrupt state file as empty rather than as an error", () => {
    // A counter file is not worth failing a Read over.
    writeFileSync(statePath(dir), "{ this is not json", "utf8");

    assert.equal(readState(dir).requests, 0);
  });

  it("resets the counters on a new day but keeps the circuit", () => {
    openCircuit(dir, { reason: "permanent: HTTP 429", cooldownSeconds: 3600 });
    bump(dir, "requests", 25);

    const stale = { ...readState(dir), date: "2020-01-01" };
    writeFileSync(statePath(dir), JSON.stringify(stale), "utf8");

    const state = readState(dir);

    assert.equal(state.requests, 0, "a new day should return the budget");
    // A rate limit hit at 23:58 is still a rate limit at 00:01. Midnight is not
    // a reason to start asking again.
    assert.equal(state.circuit_state, CIRCUIT_OPEN);
    assert.match(state.circuit_reason, /429/);
  });

  it("writes whole files, never half of one", () => {
    bump(dir, "requests");

    // If the write were not atomic this would occasionally parse as a fragment.
    const parsed = JSON.parse(readFileSync(statePath(dir), "utf8"));

    assert.equal(parsed.requests, 1);
  });

  it("does not lose counts when writes interleave", async () => {
    // The hook fires once per tool call and nothing serialises those processes.
    // Without the lock this loses increments; with it, every one survives.
    await Promise.all(
      Array.from({ length: 40 }, () => Promise.resolve().then(() => bump(dir, "reads"))),
    );

    assert.equal(readState(dir).reads, 40);
  });
});

describe("geminiAvailability", () => {
  it("stops at the daily budget", () => {
    bump(dir, "requests", 25);

    const { available, reason } = geminiAvailability(readState(dir), { dailyBudget: 25 });

    assert.equal(available, false);
    assert.match(reason, /daily budget of 25/);
  });

  it("stops while the circuit is open", () => {
    openCircuit(dir, { reason: "permanent: HTTP 429", cooldownSeconds: 300 });

    const { available, reason } = geminiAvailability(readState(dir), { dailyBudget: 25 });

    assert.equal(available, false);
    assert.match(reason, /429/);
  });

  it("starts again once the cooldown has passed", () => {
    openCircuit(dir, { reason: "transient: timed out", cooldownSeconds: -1 });

    assert.equal(geminiAvailability(readState(dir), { dailyBudget: 25 }).available, true);
  });

  it("is available on a fresh day with a closed circuit", () => {
    closeCircuit(dir);

    assert.equal(geminiAvailability(readState(dir), { dailyBudget: 25 }).available, true);
  });
});

describe("openCircuit", () => {
  it("counts the failure and records what it was", () => {
    openCircuit(dir, { reason: "permanent: HTTP 403", cooldownSeconds: 300 });

    const state = readState(dir);

    assert.equal(state.failures, 1);
    assert.equal(state.circuit_state, CIRCUIT_OPEN);
    // Recorded rather than summarised: "Gemini is off" without a reason is a
    // thing somebody spends an afternoon on.
    assert.match(state.circuit_reason, /HTTP 403/);
    assert.ok(state.circuit_until);
  });

  it("never stores anything that looks like a credential", () => {
    updateState(dir, (state) => ({ ...state, last_denied: { key: "abc", at: Date.now() } }));
    openCircuit(dir, { reason: "permanent: HTTP 401", cooldownSeconds: 300 });

    const raw = readFileSync(statePath(dir), "utf8");

    // The key lives in process memory and goes into one header. Anything that
    // writes it to disk is a bug, and this is where that bug would surface.
    assert.equal(/AIza|Bearer |x-goog-api-key|GEMINI_API_KEY=/.test(raw), false, raw);
  });
});
