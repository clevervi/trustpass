/**
 * Compares the merge bar this repository claims against the one GitHub applies.
 *
 * The claim is `.github/merge-bar.json`. The application is whatever
 * `GET /repos/{repo}/rules/branches/develop` returns. Neither is the source of
 * truth alone: GitHub decides what actually happens, and the file decides
 * whether that is what anybody agreed to.
 *
 * **The comparison is pure and the fetching is not**, so the interesting half
 * can be tested without a network or a token — which matters because the
 * failure this exists to catch is a comparison that quietly passes.
 */

/** A difference worth failing for, in the terms somebody has to act on. */
export function compareMergeBar(contract, rules) {
  const problems = [];
  const present = new Set(rules.map((rule) => rule.type));

  for (const type of contract.must_be_present) {
    if (!present.has(type)) {
      problems.push(`the rule "${type}" is not applied to develop`);
    }
  }

  const checks = rules.find((rule) => rule.type === "required_status_checks");

  if (checks) {
    const live = checks.parameters.required_status_checks.map((c) => c.context);
    const expected = contract.required_status_checks;

    for (const context of expected) {
      if (!live.includes(context)) {
        problems.push(`the check "${context}" is required by the contract and not by GitHub`);
      }
    }

    for (const context of live) {
      if (!expected.includes(context)) {
        problems.push(`GitHub requires the check "${context}", which the contract does not list`);
      }
    }

    // The property that let a rename break every merge in #181: a required
    // check whose name matches nothing that reports is still "required".
    if (
      checks.parameters.strict_required_status_checks_policy !==
      contract.strict_required_status_checks_policy
    ) {
      problems.push(
        `branches must be up to date before merging: contract says ${contract.strict_required_status_checks_policy}, GitHub says ${checks.parameters.strict_required_status_checks_policy}`,
      );
    }
  }

  const pullRequest = rules.find((rule) => rule.type === "pull_request");

  if (pullRequest) {
    for (const [key, want] of Object.entries(contract.pull_request)) {
      const got = pullRequest.parameters[key];

      if (got !== want) {
        problems.push(`pull request rule "${key}": contract says ${want}, GitHub says ${got}`);
      }
    }
  }

  return problems;
}

async function rulesForDevelop(repository, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/rules/branches/develop`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GET /rules/branches/develop answered ${response.status}`);
  }

  return response.json();
}

async function main() {
  const { readFileSync } = await import("node:fs");

  const contract = JSON.parse(
    readFileSync(new URL("../.github/merge-bar.json", import.meta.url), "utf8"),
  );

  const repository = process.env.GITHUB_REPOSITORY ?? "clevervi/trustpass";
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  const rules = await rulesForDevelop(repository, token);

  if (rules.length === 0) {
    // Distinguished from "the rules are wrong", because it is a different
    // failure with a different cause: no ruleset applies at all, so the bar
    // this file describes is not being enforced by anything readable.
    console.error("No branch rules apply to develop.");
    console.error("");
    console.error("Either the ruleset was deleted or its conditions stopped matching the branch.");
    console.error("Nothing readable from CI is enforcing the merge bar.");
    process.exit(1);
  }

  const problems = compareMergeBar(contract, rules);

  if (problems.length > 0) {
    console.error(
      `The merge bar GitHub applies is not the one ${"`.github/merge-bar.json`"} describes:`,
    );
    console.error("");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error("");
    console.error("Change one of them so they agree. If GitHub is right, the contract is stale;");
    console.error("if the contract is right, somebody edited the ruleset without saying so.");
    process.exit(1);
  }

  console.log(`The merge bar matches the contract: ${rules.length} rules applying to develop.`);
  for (const context of contract.required_status_checks) {
    console.log(`  required: ${context}`);
  }
}

// Only when run directly, so the comparison can be imported by a test.
//
// `pathToFileURL` rather than string arithmetic on `file://`. The hand-rolled
// version produced two slashes where Windows produces three, so the guard was
// false, `main` never ran, and the script exited 0 having checked nothing — a
// verifier that passes by not running is worse than no verifier.
const { pathToFileURL } = await import("node:url");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
