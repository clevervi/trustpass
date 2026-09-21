/**
 * Fails when the duplication exclusions stop having the effect they claim.
 *
 * `.sonarcloud.properties` is the only Sonar configuration this repository has
 * that is actually read — #197 established that, three times, against a
 * `sonar-project.properties` that looks plausible and is ignored. Nothing checks
 * that the file it replaced it with keeps working, and its failure mode is
 * identical: a plausible file, silently not applied.
 *
 * **What this proves and what it cannot.** SonarQube Cloud does not expose where
 * a setting came from: `.sonarcloud.properties` is read at analysis time rather
 * than stored, so the settings API reports no project override even while the
 * file is in force — measured. The only observable is the effect, so that is
 * what this checks:
 *
 *   for every file the exclusion covers
 *     it is present in the component tree
 *     it has an ncloc measure, whatever that measure says
 *     its duplication is 0
 *
 * **Presence is the load-bearing line.** It is what separates *excluded from
 * duplication* from *removed from the analysis* — `sonar.exclusions` would
 * satisfy the duplication column by deleting the files outright, which is a
 * worse change and looks identical in the number.
 *
 * `ncloc` is checked for existence rather than for being positive. An earlier
 * version required it to be above zero and rejected a migration that is
 * deliberately empty; reported-as-zero is a measurement, and only
 * not-reported-at-all says a file was not analysed.
 *
 * **Its ceiling, stated rather than discovered.** Somebody who removed the
 * exclusion *and* genuinely deduplicated the files would pass. For forward-only
 * migrations that `CONTRIBUTING.md` forbids editing, that is close to
 * impossible; for `scripts/mutations/` it would mean reshaping data this
 * repository decided in #194 not to reshape. Small, and not zero. This protects
 * an observable consequence, not the syntax of a configuration, because the
 * syntax is not observable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { forLog } from "./for-log.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROPERTIES = resolve(ROOT, ".sonarcloud.properties");

/**
 * The patterns this repository insists on, as a contract rather than as
 * whatever the file happens to say.
 *
 * Deriving the expectation entirely from the file would make the check
 * circular: delete a pattern and the guard stops expecting its effect, then
 * passes. `merge-bar.json` makes the same move against the same failure.
 */
const REQUIRED_PATTERNS = ["packages/db/drizzle/*.sql", "scripts/mutations/**"];

/** `sonar.cpd.exclusions`, as the file states it. */
export function cpdExclusions(properties) {
  const line = properties
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("sonar.cpd.exclusions="));

  if (!line) return [];

  return line
    .slice("sonar.cpd.exclusions=".length)
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

/** What the contract requires and the file does not say. */
export function missingPatterns(declared) {
  return REQUIRED_PATTERNS.filter((required) => !declared.includes(required));
}

/**
 * Whether a component's measures satisfy the property.
 *
 * Separated from fetching so the decision is testable without a network, which
 * is the same split the mutation runner makes for the same reason.
 */
export function verdictFor(component) {
  if (!component) return "absent from the analysis";

  const measure = (name) => {
    const found = (component.measures ?? []).find((m) => m.metric === name);

    return found ? Number(found.value) : null;
  };

  const ncloc = measure("ncloc");
  const duplication = measure("duplicated_lines_density");

  // Reported-as-zero is a measurement; not reported at all is an absence. The
  // first version failed on `ncloc === 0` and the guard's first run caught
  // `0017_the_snapshot_catches_up.sql` — the deliberately empty migration
  // `CONTRIBUTING.md` holds up as the worked example, whose whole body is a
  // comment explaining why it is empty. Zero lines of code in it is true.
  //
  // What distinguishes "excluded from duplication" from "removed from the
  // analysis" is presence in the tree, handled above. `ncloc` adds nothing to
  // that and was rejecting a correct file.
  if (ncloc === null) return "no ncloc — it may not have been analysed";
  if (duplication === null) return "no duplication measure";
  if (duplication !== 0) return `duplication is ${duplication}%, so the exclusion is not in force`;

  return null;
}

/**
 * The files a pattern covers, from the working tree.
 *
 * `readdirSync` rather than a shell listing. The first version ran `dir` and
 * `find`, which failed here because this checkout's path contains a space — and
 * would have needed the absolute-path treatment `git-path.mjs` gives `git`,
 * for a job the standard library already does.
 */
function expand(pattern) {
  const [directory = ""] = pattern.split("*");
  const base = resolve(ROOT, directory);

  if (!existsSync(base)) return [];

  const suffix = pattern.endsWith(".sql") ? ".sql" : ".mjs";
  const root = ROOT.replaceAll("\\", "/");

  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"))
    .map((path) => path.slice(`${root}/`.length))
    .sort();
}

/**
 * Which branch this is running on, without spawning git.
 *
 * The population comes from the working tree and the measures come from the
 * project's analysis, which is `develop`'s. Those describe the same state only
 * on `develop` — a branch that adds a file will find it missing from the
 * analysis and report an absence that is true and means nothing.
 *
 * The workflow scopes this to pushes for that reason. Run by hand on a branch it
 * would otherwise produce exactly the reading #199 produced: `ABSENT` taken for
 * `excluded`, when it meant `not in this population`.
 */
function currentBranch() {
  try {
    const head = readFileSync(resolve(ROOT, ".git/HEAD"), "utf8").trim();

    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

/**
 * The project's component tree, read without spawning anything.
 *
 * The first version ran `curl`, which searches PATH — the rule `pg-tools.ts` and
 * `git-path.mjs` both answer with an absolute path, and SonarCloud flagged it as
 * `javascript:S4036`. The better answer here is not to resolve `curl` but to
 * stop needing it: Node has `fetch`, so there is no process to spawn and no PATH
 * to trust.
 *
 * Retried, because the alternative to a transient network failure is a red build
 * with nothing wrong in this repository — the objection this check already
 * carries, narrowed where it can be.
 */
async function fetchTree() {
  const url =
    "https://sonarcloud.io/api/measures/component_tree?component=clevervi_trustpass&metricKeys=ncloc,duplicated_lines_density&qualifiers=FIL&ps=500";

  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

      if (!response.ok) {
        throw new Error(`SonarCloud answered ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, attempt * 2_000));
    }
  }

  throw new Error(
    `Could not read the analysis after four attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main() {
  const declared = cpdExclusions(readFileSync(PROPERTIES, "utf8"));
  const missing = missingPatterns(declared);

  if (missing.length > 0) {
    console.error(".sonarcloud.properties no longer excludes what it must:");
    // Read out of `.sonarcloud.properties`, so not this program's either.
    for (const pattern of missing) console.error(`  ${forLog(pattern)}`);
    console.error("");
    console.error("The reasoning for each is in that file. Removing one is a decision,");
    console.error("and this check exists so it cannot be an accident.");
    process.exitCode = 1;
    return;
  }

  const expected = REQUIRED_PATTERNS.flatMap(expand);

  // #199's lesson. An empty expectation passes every assertion below it and
  // proves nothing, which is exactly how "absent" once read as "excluded".
  if (expected.length === 0) {
    console.error("No file matched the required patterns. The check has nothing to check,");
    console.error("which is a failure rather than a pass.");
    process.exitCode = 1;
    return;
  }

  const tree = await fetchTree();
  const components = new Map((tree.components ?? []).map((c) => [c.path, c]));

  // Everything from outside goes through the sanitiser, not only the values
  // that look like text. Sonar traces the HTTP response into the log and is
  // right to: a count is a number because the API said so, and the API is not
  // this program. `merge-bar.mjs` takes the same blanket position for the same
  // reason, and the first version of this file sanitised only the branch name —
  // which is the narrow reading that leaves the next value unguarded.
  console.log(`Analysis holds ${forLog(tree.paging?.total ?? "?")} files.`);
  console.log(`The exclusions cover ${expected.length} of them.`);
  console.log("");

  const problems = expected
    .map((path) => ({ path, problem: verdictFor(components.get(path)) }))
    .filter(({ problem }) => problem !== null);

  if (problems.length === 0) {
    console.log(`Every one is present, measured, and reports no duplication.`);
    console.log("");
    console.log("That is the observable effect of the exclusion, not proof of its syntax:");
    console.log("SonarQube Cloud does not report where a setting came from.");
    return;
  }

  console.error(`${problems.length} of ${expected.length} do not satisfy the property:`);
  console.error("");

  for (const { path, problem } of problems) {
    console.error(`  ${forLog(path)}`);
    console.error(`      ${forLog(problem)}`);
  }

  console.error("");
  console.error("Either the exclusion stopped applying, or the files left the analysis.");
  console.error("Those are different failures and the message above says which.");

  const branch = currentBranch();

  if (branch !== null && branch !== "develop") {
    console.error("");
    console.error(`This ran on "${forLog(branch)}", not develop. The population above came from`);
    console.error("the working tree and the measures came from the project's analysis,");
    console.error("which is develop's — so a file this branch adds is absent for a reason");
    console.error("that says nothing about the exclusion. Read the rows before the verdict.");
  }

  // Not `process.exit`. The retry above leaves a timer pending, and exiting
  // through it crashed libuv here with `UV_HANDLE_CLOSING` and status 127 —
  // a failure mode that hides the real one behind a native assertion.
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("cpd-exclusions.mjs")) {
  await main();
}
