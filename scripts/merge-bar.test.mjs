import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { compareMergeBar, contractProblems } from "./merge-bar.mjs";

/**
 * The comparison that decides whether the merge bar is still the merge bar.
 *
 * `node:test` rather than vitest: vitest is a dependency of the workspace
 * packages and this is repository tooling that lives above them, so using it
 * here would mean adding a root dependency to test forty lines of comparison.
 * Node ships a runner.
 *
 * The failure worth guarding against is not "the rules changed" — that is what
 * the check reports. It is a comparison that finds no problems because it never
 * looked, which is how a green check comes to mean nothing. So every case below
 * is a divergence the comparison must catch, not a description of what it does.
 */

const CONTRACT = JSON.parse(
  readFileSync(new URL("../.github/merge-bar.json", import.meta.url), "utf8"),
);

/** What GitHub returns when everything agrees. Built from the contract itself. */
function matchingRules(contract = CONTRACT) {
  return [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: contract.strict_required_status_checks_policy,
        required_status_checks: contract.required_status_checks.map((context) => ({ context })),
      },
    },
    { type: "pull_request", parameters: { ...contract.pull_request } },
  ];
}

/** Built from codes, so a formatter cannot turn them into invisible literals. */
const NEWLINE = String.fromCharCode(10);
const BELL = String.fromCharCode(7);

const checksIn = (rules) => rules.find((r) => r.type === "required_status_checks");
const pullRequestIn = (rules) => rules.find((r) => r.type === "pull_request");

describe("comparing the merge bar against what GitHub applies", () => {
  it("finds nothing wrong when they agree", () => {
    assert.deepEqual(compareMergeBar(CONTRACT, matchingRules()), []);
  });

  it("reports a required check that stopped being required, by name", () => {
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks = checksIn(
      rules,
    ).parameters.required_status_checks.filter(
      (c) => c.context !== "No approval from a listed account",
    );

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /No approval from a listed account/);
    assert.match(problems[0], /required by the contract and not by GitHub/);
  });

  it("reports every check when the whole list is emptied", () => {
    // A comparison that iterated the live list would find nothing to object to
    // here, which is the bug this case exists for rather than the feature.
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks = [];

    assert.equal(compareMergeBar(CONTRACT, rules).length, CONTRACT.required_status_checks.length);
  });

  it("reports a check GitHub requires that nobody wrote down", () => {
    // Somebody adding a required check by hand is not obviously wrong, and it
    // is still drift: the repository no longer describes its own merge bar.
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks.push({ context: "Something added by hand" });

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /Something added by hand/);
    assert.match(problems[0], /the contract does not list/);
  });

  it("reports a renamed check as two problems, which is what a rename is", () => {
    // #181: renaming a required check leaves the old name required and never
    // reporting. Both halves are worth saying, because "renamed" is the
    // reader's conclusion and not the data.
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks = checksIn(
      rules,
    ).parameters.required_status_checks.map((c) =>
      c.context === "Secret scan" ? { context: "Secret scanning" } : c,
    );

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 2);
    assert.match(problems.join(" "), /Secret scan\b/);
    assert.match(problems.join(" "), /Secret scanning/);
  });

  for (const type of ["deletion", "non_fast_forward", "required_status_checks", "pull_request"]) {
    it(`reports the ${type} rule disappearing`, () => {
      const problems = compareMergeBar(
        CONTRACT,
        matchingRules().filter((rule) => rule.type !== type),
      );

      assert.ok(
        problems.some((p) => p.includes(`"${type}"`)),
        `expected a problem naming ${type}, got: ${problems.join(" | ")}`,
      );
    });
  }

  it("reports the up-to-date policy being turned off", () => {
    const rules = matchingRules();
    checksIn(rules).parameters.strict_required_status_checks_policy = false;

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /up to date/);
  });

  it("reports a pull request parameter that moved", () => {
    // Raising the approval count reads like a tightening and would break this
    // repository's bar: an approval from a listed account is refused, so
    // requiring one means nothing can ever merge.
    const rules = matchingRules();
    pullRequestIn(rules).parameters.required_approving_review_count = 1;

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /required_approving_review_count/);
  });

  it("reports thread resolution being switched off", () => {
    const rules = matchingRules();
    pullRequestIn(rules).parameters.required_review_thread_resolution = false;

    const problems = compareMergeBar(CONTRACT, rules);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /required_review_thread_resolution/);
  });

  it("finds every problem rather than stopping at the first", () => {
    // A check reporting one difference at a time would take four runs to
    // describe a configuration somebody replaced wholesale.
    const rules = matchingRules().filter((r) => r.type !== "deletion");
    pullRequestIn(rules).parameters.required_approving_review_count = 2;
    checksIn(rules).parameters.strict_required_status_checks_policy = false;

    assert.ok(compareMergeBar(CONTRACT, rules).length >= 3);
  });

  it("does not let a check name forge a line in the log", () => {
    // A ruleset's check names are set in a web interface and printed into a CI
    // log. A newline in one is a fabricated log line saying whatever the person
    // who named the check wanted. Flagged as jssecurity:S5145 and fixed rather
    // than waived, because "the only person who can set it is the person
    // reading it" is an argument that stops being true the day it matters.
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks.push({
      context: `innocent${NEWLINE}  required: Something that is not required${BELL}`,
    });

    const problems = compareMergeBar(CONTRACT, rules);
    const reported = problems.join(" ");

    assert.ok(!reported.includes(NEWLINE), "a newline reached the message");
    assert.ok(!reported.includes(BELL), "a control character reached the message");
    assert.match(reported, /innocent/);
  });

  it("truncates a check name long enough to bury the rest of the output", () => {
    const rules = matchingRules();
    checksIn(rules).parameters.required_status_checks.push({ context: "x".repeat(5000) });

    const problems = compareMergeBar(CONTRACT, rules);

    assert.ok(
      problems.every((p) => p.length < 300),
      "a message grew without bound",
    );
  });

  describe("the contract's own shape", () => {
    it("is satisfied by the committed contract", () => {
      assert.deepEqual(contractProblems(CONTRACT), []);
    });

    it("objects when must_be_present is emptied", () => {
      // The relaxation that would make every other answer meaningless: the
      // comparison skips a rule type it cannot find, so an empty list means it
      // checks nothing and reports nothing.
      const problems = contractProblems({ ...CONTRACT, must_be_present: [] });

      assert.equal(problems.length, 2);
      assert.match(problems.join(" "), /required_status_checks/);
      assert.match(problems.join(" "), /pull_request/);
    });

    it("objects when the required check list is emptied", () => {
      assert.match(
        contractProblems({ ...CONTRACT, required_status_checks: [] }).join(" "),
        /no required status checks/,
      );
    });

    it("objects when the fields are missing entirely", () => {
      assert.ok(contractProblems({}).length >= 3);
    });
  });

  it("holds the contract file to the shape the comparison assumes", () => {
    // The comparison skips a rule it cannot find. Remove `required_status_checks`
    // from `must_be_present` and the check keeps passing while no longer
    // checking the thing it exists for.
    assert.ok(CONTRACT.must_be_present.includes("required_status_checks"));
    assert.ok(CONTRACT.must_be_present.includes("pull_request"));
    assert.ok(CONTRACT.required_status_checks.length > 0);
    assert.ok(CONTRACT.required_status_checks.includes("No approval from a listed account"));
  });
});
