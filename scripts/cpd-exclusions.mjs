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
 *     it has ncloc > 0
 *     its duplication is 0
 *
 * Both halves of the first two matter. Without presence and `ncloc`,
 * `sonar.exclusions` would satisfy this by removing the files from the analysis
 * entirely — which is a different and much worse change than the one that is
 * wanted, and it would look identical in the duplication column.
 *
 * **Its ceiling, stated rather than discovered.** Somebody who removed the
 * exclusion *and* genuinely deduplicated the files would pass. For forward-only
 * migrations that `CONTRIBUTING.md` forbids editing, that is close to
 * impossible; for `scripts/mutations/` it would mean reshaping data this
 * repository decided in #194 not to reshape. Small, and not zero. This protects
 * an observable consequence, not the syntax of a configuration, because the
 * syntax is not observable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const root = ROOT.replace(/\\/g, "/");

  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => `${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"))
    .map((path) => path.slice(`${root}/`.length))
    .sort();
}

function fetchTree() {
  const out = resolve(ROOT, "node_modules/.cache/sonar-tree.json");

  execFileSync(
    "curl",
    [
      "-sS",
      "--retry",
      "5",
      "--retry-all-errors",
      "--max-time",
      "60",
      "--create-dirs",
      "-o",
      out,
      "https://sonarcloud.io/api/measures/component_tree?component=clevervi_trustpass&metricKeys=ncloc,duplicated_lines_density&qualifiers=FIL&ps=500",
    ],
    { stdio: "ignore" },
  );

  return JSON.parse(readFileSync(out, "utf8"));
}

function main() {
  const declared = cpdExclusions(readFileSync(PROPERTIES, "utf8"));
  const missing = missingPatterns(declared);

  if (missing.length > 0) {
    console.error(".sonarcloud.properties no longer excludes what it must:");
    for (const pattern of missing) console.error(`  ${pattern}`);
    console.error("");
    console.error("The reasoning for each is in that file. Removing one is a decision,");
    console.error("and this check exists so it cannot be an accident.");
    process.exit(1);
  }

  const expected = REQUIRED_PATTERNS.flatMap(expand);

  // #199's lesson. An empty expectation passes every assertion below it and
  // proves nothing, which is exactly how "absent" once read as "excluded".
  if (expected.length === 0) {
    console.error("No file matched the required patterns. The check has nothing to check,");
    console.error("which is a failure rather than a pass.");
    process.exit(1);
  }

  const tree = fetchTree();
  const components = new Map((tree.components ?? []).map((c) => [c.path, c]));

  console.log(`Analysis holds ${tree.paging?.total ?? "?"} files.`);
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
    console.error(`  ${path}`);
    console.error(`      ${problem}`);
  }

  console.error("");
  console.error("Either the exclusion stopped applying, or the files left the analysis.");
  console.error("Those are different failures and the message above says which.");

  process.exit(1);
}

if (process.argv[1]?.endsWith("cpd-exclusions.mjs")) {
  main();
}
