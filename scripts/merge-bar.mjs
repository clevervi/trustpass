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

/**
 * Anything from the API, on its way into a message somebody will read.
 *
 * A ruleset's check names are external input: they are set in a web interface
 * and this prints them into a CI log, which is the shape of a log injection —
 * a newline and a fabricated line, and the log says whatever the person who
 * named the check wanted it to say. Sonar flagged it as `jssecurity:S5145` and
 * it is right: the value is untrusted even though the person setting it today
 * is the person reading the log.
 */
function forLog(value) {
  // Character codes rather than a regular expression range. The range was
  // written as an escape sequence and the formatter rewrote it into the literal
  // control characters it denotes — which still worked, was unreadable, and
  // left a test that appeared to say `includes("")`. A guard nobody can read is
  // a guard somebody deletes.
  const readable = Array.from(String(value), (character) => {
    const code = character.codePointAt(0);

    return code < 0x20 || code === 0x7f ? " " : character;
  });

  return readable.join("").slice(0, 120);
}

/** Rules the contract says must apply, that do not. */
function missingRules(contract, rules) {
  const present = new Set(rules.map((rule) => rule.type));

  return contract.must_be_present
    .filter((type) => !present.has(type))
    .map((type) => `the rule "${type}" is not applied to develop`);
}

/** The two directions a required-check list can disagree, and the strict flag. */
function statusCheckProblems(contract, rules) {
  const checks = rules.find((rule) => rule.type === "required_status_checks");

  if (!checks) {
    return [];
  }

  const live = checks.parameters.required_status_checks.map((c) => c.context);
  const expected = contract.required_status_checks;

  const problems = [
    ...expected
      .filter((context) => !live.includes(context))
      .map(
        (context) => `the check "${forLog(context)}" is required by the contract and not by GitHub`,
      ),
    ...live
      .filter((context) => !expected.includes(context))
      .map(
        (context) =>
          `GitHub requires the check "${forLog(context)}", which the contract does not list`,
      ),
  ];

  // The property that let a rename break every merge in #181: a required check
  // whose name matches nothing that reports is still "required".
  const strict = checks.parameters.strict_required_status_checks_policy;

  if (strict !== contract.strict_required_status_checks_policy) {
    problems.push(
      `branches must be up to date before merging: contract says ${contract.strict_required_status_checks_policy}, GitHub says ${forLog(strict)}`,
    );
  }

  return problems;
}

/** Every pull request parameter the contract names, compared one by one. */
function pullRequestProblems(contract, rules) {
  const rule = rules.find((r) => r.type === "pull_request");

  if (!rule) {
    return [];
  }

  return Object.entries(contract.pull_request)
    .filter(([key, want]) => rule.parameters[key] !== want)
    .map(
      ([key, want]) =>
        `pull request rule "${key}": contract says ${want}, GitHub says ${forLog(rule.parameters[key])}`,
    );
}

/**
 * Every difference worth failing for, in the terms somebody has to act on.
 *
 * Three functions rather than one body, because the first version was one and
 * Sonar put its cognitive complexity at 22 against a limit of 15. It was right
 * that the limit was the smaller problem: the three comparisons are independent
 * and reading one meant reading past the other two.
 */
export function compareMergeBar(contract, rules) {
  return [
    ...missingRules(contract, rules),
    ...statusCheckProblems(contract, rules),
    ...pullRequestProblems(contract, rules),
  ];
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

  // Every number and string here comes from the contract file, and none from
  // the response. Sonar flagged the earlier version for interpolating
  // `rules.length` — a count, and still a value derived from an HTTP response
  // reaching a log. Printing what this repository requires says the same thing
  // and is sourced from something under review, which is the better sentence
  // anyway: the finding is that the contract holds, not that the API replied.
  const required = contract.must_be_present.length;

  console.log(`The merge bar matches the contract: ${required} rules required on develop.`);
  for (const context of contract.required_status_checks) {
    console.log(`  required check: ${forLog(context)}`);
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
