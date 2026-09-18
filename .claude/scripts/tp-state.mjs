/**
 * Counters, the daily budget and the circuit breaker.
 *
 * Every number here is an estimate of this router's own behaviour. None of it
 * is billing, none of it is Google's quota, and the stats command says so.
 *
 * Two processes can hold this file at once — a hook fires per tool call and
 * nothing serialises them — so every write takes a lock. The lock is a
 * directory, because `mkdir` is the one filesystem operation that is atomic and
 * fails loudly when the target exists on both Windows and POSIX. A lock file
 * with `wx` would work too; a directory needs no flag translation.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A lock older than this is assumed to belong to a process that died. */
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 60;

export const CIRCUIT_CLOSED = "closed";
export const CIRCUIT_OPEN = "open";

/**
 * Failures that mean "stop asking", and failures that mean "ask once more".
 *
 * The distinction is the whole retry policy. A 429 or a rejected key does not
 * become true by being asked again, and a retry loop against a rate limit is
 * how a helper turns into an outage.
 */
export const FAILURE_PERMANENT = "permanent";
export const FAILURE_TRANSIENT = "transient";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyState() {
  return {
    date: today(),
    reads: 0,
    direct_reads: 0,
    delegated_candidates: 0,
    delegated: 0,
    requests: 0,
    failures: 0,
    cache_hits: 0,
    fallbacks: 0,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    estimated_tokens_saved: 0,
    circuit_state: CIRCUIT_CLOSED,
    circuit_reason: null,
    circuit_until: null,
    last_failure: null,
  };
}

export function statePath(stateDir) {
  return join(stateDir, "router-state.json");
}

function lockPath(stateDir) {
  return join(stateDir, ".lock");
}

function acquire(stateDir) {
  const lock = lockPath(stateDir);
  mkdirSync(stateDir, { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lock);
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      // Somebody else holds it, or somebody died holding it. Only the second
      // case is ours to clean up, and only after long enough that a live
      // process could not still be inside its own write.
      try {
        const heldFor = Date.now() - statSafe(lock);
        if (heldFor > STALE_LOCK_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder released it between our mkdir and our stat. Try again.
      }

      sleep(LOCK_RETRY_MS);
    }
  }

  // Never block the hook on a lock. A lost counter is worth nothing; a Read
  // that hangs because a stats file is busy is worth less than nothing.
  return null;
}

function statSafe(path) {
  return statSync(path).mtimeMs;
}

function sleep(ms) {
  // Synchronous on purpose: the hook is a short-lived process and an async
  // lock would need every caller to be async for no benefit.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readState(stateDir) {
  const path = statePath(stateDir);

  if (!existsSync(path)) {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    // A new day resets the counters and the budget, but not the circuit: a
    // rate limit that was hit at 23:58 is still a rate limit at 00:01.
    if (parsed.date !== today()) {
      return { ...emptyState(), ...pickCircuit(parsed), date: today() };
    }

    return { ...emptyState(), ...parsed };
  } catch {
    // A corrupt state file is a counter problem, never a routing problem.
    return emptyState();
  }
}

function pickCircuit(state) {
  return {
    circuit_state: state.circuit_state ?? CIRCUIT_CLOSED,
    circuit_reason: state.circuit_reason ?? null,
    circuit_until: state.circuit_until ?? null,
    last_failure: state.last_failure ?? null,
  };
}

/**
 * Read, change, write, under the lock. The mutation gets the current state and
 * returns the next one.
 */
export function updateState(stateDir, mutate) {
  const lock = acquire(stateDir);

  try {
    const next = mutate(readState(stateDir));
    const path = statePath(stateDir);

    mkdirSync(dirname(path), { recursive: true });

    // Write beside it and rename, so a reader never sees half a file. rename
    // over an existing path is atomic on POSIX and on NTFS.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, path);

    return next;
  } catch {
    return readState(stateDir);
  } finally {
    if (lock) {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

export function bump(stateDir, field, by = 1) {
  return updateState(stateDir, (state) => ({ ...state, [field]: (state[field] ?? 0) + by }));
}

/**
 * Whether Gemini may be called at all, and why not when it may not.
 *
 * Deliberately does not consider the cache — the caller checks that first, so
 * an exhausted budget still serves a summary it already has.
 */
export function geminiAvailability(state, { dailyBudget }) {
  if (state.circuit_state === CIRCUIT_OPEN) {
    const until = state.circuit_until ? Date.parse(state.circuit_until) : 0;

    if (!until || Date.now() < until) {
      return { available: false, reason: state.circuit_reason ?? "circuit open" };
    }
  }

  if (state.requests >= dailyBudget) {
    return { available: false, reason: `daily budget of ${dailyBudget} requests is spent` };
  }

  return { available: true, reason: null };
}

export function openCircuit(stateDir, { reason, cooldownSeconds }) {
  return updateState(stateDir, (state) => ({
    ...state,
    failures: (state.failures ?? 0) + 1,
    circuit_state: CIRCUIT_OPEN,
    circuit_reason: reason,
    circuit_until: new Date(Date.now() + cooldownSeconds * 1000).toISOString(),
    last_failure: new Date().toISOString(),
  }));
}

export function closeCircuit(stateDir) {
  return updateState(stateDir, (state) => ({
    ...state,
    circuit_state: CIRCUIT_CLOSED,
    circuit_reason: null,
    circuit_until: null,
  }));
}
