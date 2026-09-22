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
/**
 * A test name as a selector that means exactly that name.
 *
 * `vitest -t` and `node --test --test-name-pattern` both take a **regular
 * expression**. A mutation declares a literal test name, and the two are not the
 * same language: #215 found `counts one IPv6 allocation as one caller, not as
 * 2^64 of them` selecting nothing at all, because `^` is an anchor.
 *
 *   new RegExp(thatName).test(thatName)  ->  false
 *
 * So the name is escaped into a pattern that matches itself and nothing else it
 * did not already match. The property is not "escape carets"; it is that **a
 * selector cannot mean something other than the literal identity the set
 * declares.** A name containing `.` would otherwise select a neighbouring test
 * whose name differs by one character, and report a verdict about it.
 */
export function nameSelector(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Whether a run that ended cleanly actually executed anything.
 *
 * **The hole #215 found**, and the reason it is a separate question from the
 * one below. `classify` answers `pass` on a zero exit before reading any prose,
 * deliberately — an earlier version checked the no-such-test patterns first and
 * one of them fired on this file's own test names. That ordering is right and
 * stays.
 *
 * What it misses is that a filter selecting nothing **also** exits zero:
 *
 *   $ vitest run src/http/ -t "matches nothing"
 *     Test Files  4 skipped (4)
 *           Tests  89 skipped (89)
 *     exit: 0
 *
 * Measured. So a mutation whose selector matched no test was reported as a guard
 * that survived — or, worse, could have been reported as one that was caught.
 *
 * Anchored to the start of a line, because the trap this file already fell into
 * was a pattern matching a *test name* rather than a summary. A name would have
 * to begin a line with the runner's own summary word to be mistaken for one.
 */
export function ranNothing(output) {
  // vitest: `Tests  22 passed (22)` / `Tests  89 skipped (89)`.
  const vitest = output.match(/^\s*Tests\s+(.+)$/m);

  if (vitest) return !/\b[1-9]\d* (passed|failed)\b/.test(vitest[1]);

  // node --test: `ℹ pass 22`, on its own line.
  const node = output.match(/^\s*ℹ\s+pass\s+(\d+)\s*$/m);

  if (node) return node[1] === "0";

  // No summary at all is not evidence either way, and answering "nothing ran"
  // here would turn every runner this does not recognise into a refusal.
  return false;
}

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
    // …unless nothing ran. A clean exit over an empty selection is not a
    // passing test, and reporting it as one is #215: a verdict about a guard
    // the runner never exercised.
    return ranNothing(output) ? "no-such-test" : "pass";
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

  return sets.filter(
    (set) => set.protects.some((file) => changed.has(file)) || changed.has(definitionOf(set)),
  );
}

/**
 * Where a set's own definition lives.
 *
 * A set is also selected when its definition changes, and that half was missing.
 * Found by this runner's own CI: the pull request that added the `qr-route` set
 * selected nothing, because the set protects a route the pull request did not
 * touch — it only added the set, the test and a config alias. The set was
 * introduced and never executed, and the run was green.
 *
 * That is the shape #194 exists to remove: a result that looks like coverage and
 * is not. A set nobody has run is a claim, and a claim is what the whole
 * mechanism replaces.
 *
 * Derived from the name by convention rather than declared, because a declared
 * path is a second place to keep in step. `runSet` refuses a set whose
 * definition is not where this says it is, on the same rule it applies to
 * `protects`.
 */
export function definitionOf(set) {
  return `scripts/mutations/${set.name}.mjs`;
}

/** Runs one named test inside a set's runner, and says why it ended. */
function runTest(set, name) {
  const [command, ...rest] = set.runner.command;
  // **Two transformations sit between a name and the test it selects**, and
  // #215 found both lying.
  //
  // The flag takes a regular expression while the set declares a literal name,
  // so the name is escaped into a pattern that means itself.
  //
  // And on Windows the command goes through a shell — `pnpm` is `pnpm.cmd` and
  // `spawnSync` will not find it otherwise — where arguments are concatenated
  // rather than passed, which Node's own DEP0190 says out loud. Measured: the
  // selector `answers 429 once the burst is spent` ran **four** tests, because
  // the shell split it and `-t answers` is what filtered. Every multi-word name
  // in every set was selecting by its first word.
  //
  // Quoting closes that. It is the narrowest fix: the alternative is resolving
  // `pnpm` by absolute path the way `git-path.mjs` does for git, which is a
  // better answer and a larger one.
  const shell = process.platform === "win32";
  const selector = name ? nameSelector(name) : undefined;
  const args = selector ? [...rest, set.runner.nameFlag, shell ? `"${selector}"` : selector] : rest;

  const result = spawnSync(command, args, {
    cwd: resolve(ROOT, set.runner.cwd),
    encoding: "utf8",
    shell,
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

  // And the set's own file, because the selector finds it by convention. A set
  // renamed without its file moving would stop being selected by its own
  // changes, silently — which is the failure this check exists to make loud.
  if (!existsSync(resolve(ROOT, definitionOf(set)))) {
    console.error(`  the set is named "${set.name}" but ${definitionOf(set)} does not exist`);
    console.error("  the selector finds a set's own definition by that name, so it would");
    console.error("  never be selected by a change to itself.");
    return false;
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
