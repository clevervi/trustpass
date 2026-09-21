/**
 * Fails when the duplication exclusions stop having the effect they claim.
 *
 * `.sonarcloud.properties` is the only Sonar configuration this repository has
 * that is actually read — #197 established that, three times, against a
 * `sonar-project.properties` that looked plausible and was ignored, and that has
 * since been deleted for that reason. Nothing checked
 * that the file it replaced it with keeps working, and its failure mode is
 * identical: a plausible file, silently not applied.
 *
 * **What this proves and what it cannot.** SonarQube Cloud does not expose where
 * a setting came from: `.sonarcloud.properties` is read at analysis time rather
 * than stored, so the settings API reports no project override even while the
 * file is in force — measured. The only observable is the effect, so that is
 * what this checks:
 *
 *   for every file the exclusion covers, at the revision that was analysed
 *     it is present in the component tree
 *     it has an ncloc measure, whatever that measure says
 *     its duplication is 0
 *
 * **"At the revision that was analysed" is not a detail, and #202 is what it
 * cost to learn.** The first version took its population from the working tree
 * and its measures from the most recent completed analysis, then assumed that on
 * `develop` those describe one state. They describe one state *eventually*.
 * SonarCloud analyses a push asynchronously and the merge bar starts at once, so
 * the guard's own first run on `develop` compared a tree containing two new
 * files against an analysis fifty-four minutes older than them, and called them
 * absent. True, and about the wrong population.
 *
 * Knowing the revision is what separates **not analysed yet** from **no longer
 * analysed**, and those are the two answers this entire check exists to tell
 * apart. So the population comes from that revision's tree, and both sides of the
 * comparison describe one commit.
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
 * **Its ceiling, stated rather than discovered.** Two of them now. Somebody who
 * removed the exclusion *and* genuinely deduplicated the files would pass; for
 * forward-only migrations that `CONTRIBUTING.md` forbids editing that is close to
 * impossible, and for `scripts/mutations/` it would mean reshaping data #194
 * decided not to reshape. And because the population is pinned to the analysed
 * revision, the claim is *the exclusions were in force as of that revision* — a
 * push that removes one while the analysis lags is caught on the next run rather
 * than on itself. Both are smaller than they look from the outside, and both are
 * what the data supports.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { forLog } from "./for-log.mjs";
import { git } from "./git-path.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROPERTIES = resolve(ROOT, ".sonarcloud.properties");
const PROJECT = "clevervi_trustpass";

// `merge-bar.mjs` reads the same variable, and the literal is the fallback for a
// run by hand. A fork would read its own tree and the analysis of this project,
// which disagree — but that is already true of every other read here.
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "clevervi/trustpass";

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
 * Whether one path is covered by one Sonar pattern.
 *
 * `*` stops at a path separator and `**` crosses them, which is Sonar's own
 * rule and is the difference between `packages/db/drizzle/*.sql` meaning *the
 * migrations* and meaning *every `.sql` file underneath, however deep*. The
 * first version approximated this by taking the text before the first `*` as a
 * directory and matching on file extension, which read both patterns as `**`
 * and would have quietly enlarged the population if anybody ever nested a
 * directory in there.
 */
export function matchesPattern(path, pattern) {
  const expression = pattern
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";

      return part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    })
    .join("");

  return new RegExp(`^${expression}$`).test(path);
}

/** The subset of a file list the exclusions cover, sorted. */
export function coveredFiles(paths, patterns = REQUIRED_PATTERNS) {
  return paths.filter((path) => patterns.some((pattern) => matchesPattern(path, pattern))).sort();
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
 * A value as a revision this program is willing to hand to git, or `null`.
 *
 * `jssecurity:S6350`, and the rule is right. The revision arrives in
 * SonarCloud's HTTP response, and `execFileSync` spawns no shell but git still
 * parses its own arguments: a "revision" beginning with `-` is read as an
 * option, and `--upload-pack=` is a command. The API is not this program, which
 * is the same reason every value it returns already goes through `forLog`.
 *
 * A full hexadecimal object name, or nothing. Not a sanitiser that strips the
 * dangerous parts and hopes — the shapes git accepts are many and the one this
 * needs is exactly one, so anything else takes the documented fallback.
 *
 * **It answers with the value rather than with a boolean**, so the only way to
 * reach the spawn is through a binding this function produced. A predicate
 * leaves the original variable in scope and correct only by discipline; this
 * makes passing the unchecked one impossible rather than merely wrong.
 */
export function asRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/**
 * One git invocation whose arguments are all written here, by absolute path.
 *
 * Only for fixed arguments. Nothing from outside this program is passed to git,
 * and the one thing that used to be no longer needs a process at all.
 */
function fromGit(args) {
  try {
    return execFileSync(git(), args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every file in a revision's tree, read over HTTP rather than from git.
 *
 * **This began as `git ls-tree` and SonarCloud reported `jssecurity:S6350`
 * three times.** The value is a revision out of SonarCloud's own response, and
 * `execFileSync` spawns no shell but git parses its own arguments: a "revision"
 * beginning with `-` is an option and `--upload-pack=` is a command. `asRevision`
 * closed that, then closed it adjacent to the spawn, and the taint analysis
 * followed neither.
 *
 * At which point the interesting question stopped being how to convince it. This
 * file already answers it once, about `curl` and `javascript:S4036`: the better
 * move is not to make the spawn safe but to stop needing one. GitHub serves the
 * tree of any revision, so there is no process, no PATH, and no argument parser
 * — the sink is gone rather than guarded, and the check no longer needs the
 * revision to be in local history either.
 *
 * `asRevision` stays. It is what keeps the value out of a URL as much as out of
 * a command line, and it is cheaper than the failure it prevents.
 *
 * `null` when the revision cannot be read, which the caller announces before it
 * falls back — including when GitHub truncates a tree too large for one page.
 * A short list would silently shrink the population, and a check with nothing
 * left to check is #199's failure wearing different clothes.
 */
async function filesAt(revision) {
  const checked = asRevision(revision);

  if (checked === null) return null;

  const token = process.env.GITHUB_TOKEN;

  try {
    const tree = await read(
      `https://api.github.com/repos/${REPOSITORY}/git/trees/${checked}?recursive=1`,
      "the analysed revision's tree",
      token ? { authorization: `Bearer ${token}` } : {},
    );

    if (tree.truncated) return null;

    return (tree.tree ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
  } catch {
    return null;
  }
}

/**
 * Every file under the literal prefix of each required pattern, from disk.
 *
 * The fallback population, for when the analysed revision cannot be resolved.
 * `readdirSync` rather than a shell listing: the first version ran `dir` and
 * `find`, which failed here because this checkout's path contains a space — and
 * would have needed the absolute-path treatment `git-path.mjs` gives `git`, for
 * a job the standard library already does.
 */
function filesOnDisk() {
  const root = ROOT.replaceAll("\\", "/");

  return REQUIRED_PATTERNS.flatMap((pattern) => {
    const [directory = ""] = pattern.split("*");
    const base = resolve(ROOT, directory);

    if (!existsSync(base)) return [];

    return readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"))
      .map((path) => path.slice(`${root}/`.length));
  });
}

/**
 * Which branch this is running on, without spawning git.
 *
 * Kept even now that the population is pinned to a revision: the message it
 * feeds explains a *branch* mismatch, which is a different confusion from a
 * *revision* one and still worth naming. Reading `.git/HEAD` rather than asking
 * git, because this one does not need a process.
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
 * One read over HTTP, retried.
 *
 * `fetch` rather than `curl`: the first version spawned it, which searches PATH
 * — the rule `pg-tools.ts` and `git-path.mjs` both answer with an absolute path,
 * and SonarCloud flagged it as `javascript:S4036`. The better answer was not to
 * resolve `curl` but to stop needing it. The same argument later removed the
 * `git ls-tree` spawn, for the same reason and one rule along.
 *
 * Retried, because the alternative to a transient network failure is a red build
 * with nothing wrong in this repository — the objection this check already
 * carries, narrowed where it can be. **A 4xx is not retried**: an unknown
 * revision or a missing project is an answer, and asking four times makes it no
 * truer while making a failure take half a minute to report.
 */
async function read(url, what, headers = {}) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });

      if (response.status >= 400 && response.status < 500) {
        throw Object.assign(new Error(`answered ${response.status}`), { final: true });
      }

      if (!response.ok) {
        throw new Error(`answered ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      if (error?.final) throw new Error(`Could not read ${what}: ${error.message}`);

      lastError = error;
      await new Promise((done) => setTimeout(done, attempt * 2_000));
    }
  }

  throw new Error(
    `Could not read ${what} after four attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** The revision the project's current analysis describes, and when it ran. */
async function analysedRevision() {
  const found = await read(
    `https://sonarcloud.io/api/project_analyses/search?project=${PROJECT}&branch=develop&ps=1`,
    "the analysis history",
  );

  const [latest] = found.analyses ?? [];

  return latest?.revision ? { revision: latest.revision, date: latest.date } : null;
}

/** The project's component tree. */
function componentTree() {
  return read(
    `https://sonarcloud.io/api/measures/component_tree?component=${PROJECT}&metricKeys=ncloc,duplicated_lines_density&qualifiers=FIL&ps=500`,
    "the analysis",
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

  const analysis = await analysedRevision();
  const head = fromGit(["rev-parse", "HEAD"]);

  // The population and the measures must describe one commit. #202: taking the
  // population from the working tree while the measures came from an older
  // analysis reported two brand new files as "absent from the analysis" — true
  // of that analysis, and nothing at all about the exclusion.
  const tree = analysis ? await filesAt(analysis.revision) : null;
  const expected = coveredFiles(tree ?? filesOnDisk());

  if (tree) {
    const current = analysis.revision === head;
    const short = (revision) => forLog(String(revision ?? "unknown").slice(0, 7));
    const relation = current ? "which is HEAD" : `not HEAD (${short(head)})`;

    console.log(`Analysis describes ${short(analysis.revision)}, ${relation}.`);

    if (!current) {
      console.log("So the population below is that revision's, not the working tree's,");
      console.log("and a file added since is out of scope rather than missing.");
    }
  } else {
    // Loudly, because this is the weaker reading and it should not pass as the
    // strong one. An unresolvable revision is the case #202 was about.
    console.log("The analysed revision could not be resolved — falling back to the");
    console.log("working tree. A file newer than the analysis will read as absent,");
    console.log("which says nothing about the exclusion. Read the rows, not the verdict.");
  }

  // #199's lesson. An empty expectation passes every assertion below it and
  // proves nothing, which is exactly how "absent" once read as "excluded".
  if (expected.length === 0) {
    console.error("No file matched the required patterns. The check has nothing to check,");
    console.error("which is a failure rather than a pass.");
    process.exitCode = 1;
    return;
  }

  const measured = await componentTree();
  const components = new Map((measured.components ?? []).map((c) => [c.path, c]));

  // Everything from outside goes through the sanitiser, not only the values
  // that look like text. Sonar traces the HTTP response into the log and is
  // right to: a count is a number because the API said so, and the API is not
  // this program. `merge-bar.mjs` takes the same blanket position for the same
  // reason, and the first version of this file sanitised only the branch name —
  // which is the narrow reading that leaves the next value unguarded.
  console.log(`Analysis holds ${forLog(measured.paging?.total ?? "?")} files.`);
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
    console.error(`This ran on "${forLog(branch)}", not develop. The measures come from the`);
    console.error("project's analysis, which is develop's, so a file that exists only on");
    console.error("this branch is absent for a reason that says nothing about the");
    console.error("exclusion. Read the rows before the verdict.");
  }

  // Not `process.exit`. The retry above leaves a timer pending, and exiting
  // through it crashed libuv here with `UV_HANDLE_CLOSING` and status 127 —
  // a failure mode that hides the real one behind a native assertion.
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("cpd-exclusions.mjs")) {
  await main();
}
