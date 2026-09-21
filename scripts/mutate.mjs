/**
 * Runs a committed mutation set: break a guard on purpose, watch a named test
 * go red, restore, report.
 *
 * `CONTRIBUTING.md` requires this for every guard at `high` or `critical` risk,
 * and until now nothing in the repository could re-run one. 44 merged pull
 * requests carry a mutation table and none of them is reproducible — #194 has
 * the measurement and the contract this implements.
 *
 * **What a green run means, and what it does not.** On a pull request this runs
 * only the sets whose declared files the diff touches. That is an execution
 * optimisation, not a guarantee: a change to something a guard depends on but
 * does not name leaves its set unselected, and the pull request goes green
 * having checked nothing about it. The guarantee is the scheduled run, which
 * ignores the selector and runs everything. Both halves are printed so a reader
 * can tell which one they are looking at.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./git-path.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Why a test run ended, which is not the same as whether it ended red.
 *
 * A mutant that references a renamed identifier does not compile. The runner
 * exits non-zero, and a harness reading only the exit code reports the guard as
 * caught — a green row for an assertion that never ran. That happened, in the
 * scratch harness this replaces, and it was found by accident.
 *
 * So a red run only counts when the failure is an assertion.
 */
export function classify(output, status) {
  // **A zero exit is a pass, whatever the output says, and this has to come
  // first.** Every rule below reads prose, and prose contains whatever a test
  // name contains.
  //
  // Found by the runner's own mutation set. The first version checked the
  // no-such-test patterns first, and one of those patterns was a bare
  // `matched` — which fired on this file's own test called "refuses to read a
  // filter that matched nothing as a pass". A green suite was reported as
  // having matched no tests, and the set that checks the runner could not even
  // establish a baseline.
  if (status === 0) {
    return "pass";
  }

  // A name filter matching nothing exits non-zero and proves nothing. Phrases
  // rather than words: vitest says "No test files found", `node --test` reports
  // `tests 0`. `matched` alone matched this file.
  if (/No test (files )?found|no tests? matched|tests 0\b/i.test(output)) {
    return "no-such-test";
  }

  if (
    /Transform failed|Expected ";" but found|error TS\d+|is not defined|Cannot find (name|module)|SyntaxError|ERR_MODULE/i.test(
      output,
    )
  ) {
    return "broken-build";
  }

  return /AssertionError|expected .* to (be|equal|contain)|strictEqual|deepEqual|toBe|toEqual/i.test(
    output,
  )
    ? "failed-assertion"
    : "failed-other";
}

/**
 * What a mutation proved, from the two runs around it.
 *
 * `restored` matters as much as `broken`: a test that was already red says
 * nothing about the mutant, and reporting it as caught would be the same error
 * as counting a compile failure.
 */
export function verdict(broken, restored) {
  if (broken === "broken-build") return "invalid";
  if (restored !== "pass") return "already-red";

  return broken === "failed-assertion" ? "caught" : "survived";
}

/**
 * Applies one patch, or says why it could not.
 *
 * Two refusals rather than a silent pass, both earned. An anchor that no longer
 * matches is the ordinary result of a refactor, and a harness that reports
 * `survived` for a patch it never applied accuses a working test. A patch that
 * matches but replaces like with like is the same failure wearing a different
 * hat.
 */
export function applyPatch(source, { from, to }) {
  if (!source.includes(from)) {
    return { problem: "anchor-missing" };
  }

  const patched = source.replace(from, to);

  if (patched === source) {
    return { problem: "no-op" };
  }

  return { patched };
}

/**
 * A set's mutations, flattened out of the files they belong to.
 *
 * The definitions group by file — one entry per file, then the mutations inside
 * it — because `file:` repeated on every mutation is the same string written
 * eighteen times, and a scanner reading it as copy-paste was not wrong about the
 * shape even if it was wrong about the cause.
 *
 * Grouping is also how the sets read: a set protects files, and each file has
 * things that can be broken in it.
 */
export function flatten(groups) {
  return groups.flatMap(({ file, mutations }) =>
    mutations.map((mutation) => ({ ...mutation, file })),
  );
}

/**
 * The sets a diff touches.
 *
 * Computed, never chosen. A set that depended on somebody remembering to name it
 * on a pull request would be run when nobody is busy — #194 makes the point, and
 * it is the reason this takes a file list rather than a label.
 */
export function selectSets(sets, changedFiles) {
  const changed = new Set(changedFiles);

  return sets.filter((set) => set.protects.some((file) => changed.has(file)));
}

/** Runs one named test inside a set's runner, and says why it ended. */
function runTest(set, name) {
  const [command, ...rest] = set.runner.command;
  const args = name ? [...rest, set.runner.nameFlag, name] : rest;

  const result = spawnSync(command, args, {
    cwd: resolve(ROOT, set.runner.cwd),
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  return classify(`${result.stdout}${result.stderr}`, result.status);
}

/** The files a pull request changed, as git sees them. */
function changedFiles(base) {
  const output = execFileSync(git(), ["diff", "--name-only", `${base}...HEAD`], {
    cwd: ROOT,
    encoding: "utf8",
  });

  return output.split("\n").filter((line) => line.trim() !== "");
}

function runSet(set) {
  console.log(`\n== ${set.name} (#${set.issue}) ==`);

  // A set that no longer describes the code cannot report on it. Same rule as a
  // stale anchor, and the same reason #172 gives about its completeness check.
  for (const file of set.protects) {
    if (!existsSync(resolve(ROOT, file))) {
      console.error(`  the set protects ${file}, which does not exist`);
      return false;
    }
  }

  const baseline = runTest(set, "");

  if (baseline !== "pass") {
    console.error(`  the suite is not green before any mutation: ${baseline}`);
    return false;
  }

  let healthy = true;

  for (const mutation of flatten(set.mutations)) {
    const path = resolve(ROOT, mutation.file);
    const original = readFileSync(path, "utf8");
    const { patched, problem } = applyPatch(original, mutation);

    if (problem) {
      console.error(`  ${problem.padEnd(16)} ${mutation.label}`);
      healthy = false;
      continue;
    }

    writeFileSync(path, patched);
    const broken = runTest(set, mutation.test);
    writeFileSync(path, original);
    const restored = runTest(set, mutation.test);

    const result = verdict(broken, restored);
    const line = `  ${result.padEnd(16)} ${mutation.label.padEnd(46)} -> ${mutation.test}`;

    if (result === "caught") {
      console.log(line);
    } else {
      console.error(`${line}  (broken=${broken} restored=${restored})`);
      healthy = false;
    }
  }

  return healthy;
}

async function main() {
  const base = process.env.MUTATION_BASE;
  const { SETS } = await import("./mutations/index.mjs");

  const selected = base ? selectSets(SETS, changedFiles(base)) : SETS;
  const skipped = SETS.filter((set) => !selected.includes(set));

  console.log(base ? `Selecting against ${base}.` : "Running every set.");
  console.log("");
  console.log("selected:");
  for (const set of selected) console.log(`  ${set.name}`);
  if (selected.length === 0) console.log("  (none)");

  console.log("");
  console.log("not selected:");
  for (const set of skipped) console.log(`  ${set.name}`);
  if (skipped.length === 0) console.log("  (none)");

  // Not a failure, deliberately. Making it one would put the cost of every set
  // back on every pull request, which is what the selector exists to avoid. It
  // is printed so that a green result cannot be read as "these guards are
  // checked" — the schedule is what says that.
  if (skipped.length > 0) {
    console.log("");
    console.log("Those were not run. This result says nothing about them.");
  }

  const healthy = selected.map(runSet).every(Boolean);

  console.log("");

  if (!healthy) {
    console.error("A mutation was not caught, or a set could not be run.");
    process.exit(1);
  }

  // The wording is part of the contract rather than decoration. "Every selected
  // set caught every mutation" is true when nothing was selected, and reads as
  // though something was checked — which is the one sentence this whole
  // mechanism exists to stop anybody writing.
  if (selected.length === 0) {
    console.log("No set was selected. Nothing was mutation-checked by this run.");
    return;
  }

  console.log(
    skipped.length === 0
      ? `Every set ran — ${selected.length} of them — and caught every mutation.`
      : `${selected.length} set(s) ran and caught every mutation. ${skipped.length} were not checked.`,
  );
}

if (process.argv[1]?.endsWith("mutate.mjs")) {
  await main();
}
