/**
 * Fails when a squash merge has landed on `develop`.
 *
 * A squash rewrites the author of the commit it produces: the result is
 * attributed to whoever opened the pull request, not to whoever wrote the code.
 * #192 has the measurement — #182's branch carried one commit by `Raishark` and
 * `develop` records `SweetZer0`, while #169's three commits came out as
 * `dependabot[bot]` because dependabot opened it. Every pull request here is
 * opened with one account's token, so every squash reads as that account.
 *
 * **This does not prevent anything, and should not be described as if it did.**
 * Prevention is the repository setting, and a workflow cannot read that setting
 * to confirm it: `GET /repos/{owner}/{repo}` returns 200 and omits
 * `allow_squash_merge` for a token without push or admin. Measured, in the probe
 * #192 records. Checking it from CI would need a stored administration token,
 * which is the trade #165 refused.
 *
 * So this catches a squash after it has happened. That is worth having anyway:
 * the defect in #182 was not that a squash is possible, it was that one went
 * unnoticed for weeks. Loud beats silent even when it is late.
 */
import { execFileSync } from "node:child_process";

/**
 * Where the rule starts applying.
 *
 * 54 of the commits before this were squash-merged and they stay as they are —
 * this repository does not rewrite history, and a rule that failed on its own
 * past would be turned off within a day rather than obeyed.
 *
 * `dd1c7a4` is `develop` at the moment the policy was written.
 */
const POLICY_BEGINS = "dd1c7a4f4b1b846a2d9e97bdedc1b186b64a476d";

/**
 * A commit GitHub produced by squashing, told apart from one it produced by
 * merging.
 *
 * Both have `GitHub <noreply@github.com>` as committer — that is what makes the
 * committer alone useless here. The subject is what separates them: GitHub
 * writes `Merge pull request #N from …` for a merge commit and the branch's own
 * subject, plus ` (#N)`, for a squash.
 *
 * A rebase-merged commit is not GitHub's at all. It keeps the author who wrote
 * it and records the person who merged as committer, which is what the two
 * fields are for.
 *
 * Checked against this repository's history: of 203 commits on `develop`, 54
 * match this, 0 are merge commits and 149 have a human committer. The 54 are
 * exactly the commits whose subject ends in `(#N)` — two independent signals
 * agreeing, which is why this one is trusted.
 */
export function squashedCommits(commits) {
  return commits.filter(
    (commit) => commit.committer === "GitHub" && !commit.subject.startsWith("Merge pull request"),
  );
}

/**
 * The field separator, built rather than typed.
 *
 * `git log --format=%x01` emits U+0001, which no commit subject contains.
 * Typing it as a literal writes an invisible control character into this file,
 * where a formatter can rewrite it and the next reader cannot see what the
 * delimiter is. That has already cost this repository a test that appeared to
 * say `includes("")`.
 */
const FIELD = String.fromCharCode(1);

/** One commit per line, split on a delimiter no commit subject can contain. */
export function parseLog(output) {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha = "", committer = "", author = "", ...rest] = line.split(FIELD);

      return { sha, committer, author, subject: rest.join(FIELD) };
    });
}

function main() {
  let output;

  try {
    output = execFileSync(
      "git",
      ["log", `${POLICY_BEGINS}..HEAD`, "--format=%h%x01%cn%x01%an <%ae>%x01%s"],
      { encoding: "utf8" },
    );
  } catch (error) {
    // A shallow clone cannot see the baseline, and a check that cannot see what
    // it is checking must say so rather than pass. `fetch-depth: 0`.
    console.error("Could not read the history between the policy baseline and HEAD.");
    console.error(`Baseline: ${POLICY_BEGINS}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const squashed = squashedCommits(parseLog(output));

  if (squashed.length === 0) {
    console.log("No squash merges since the policy baseline.");
    return;
  }

  console.error(`${squashed.length} squash merge(s) have landed on develop:`);
  console.error("");

  for (const commit of squashed) {
    console.error(`  ${commit.sha}  ${commit.subject}`);
    console.error(`            now attributed to ${commit.author}`);
  }

  console.error("");
  console.error("A squash attributes the result to whoever opened the pull request, not to");
  console.error("whoever wrote the code. Use rebase for a feature branch — CONTRIBUTING.md");
  console.error("says so and #192 has the measurement.");
  console.error("");
  console.error("Nothing here can be corrected without rewriting history, which this");
  console.error("repository does not do. What can be corrected is the next one.");

  process.exit(1);
}

if (process.argv[1]?.endsWith("no-squash.mjs")) {
  main();
}
