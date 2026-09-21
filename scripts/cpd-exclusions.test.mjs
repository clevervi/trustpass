/**
 * The deciding halves of the duplication-exclusion check.
 *
 * A check that cannot tell "excluded from duplication" from "removed from the
 * analysis" would pass for `sonar.exclusions`, which is a much worse change than
 * the one #194 argued for and looks identical in the duplication column. That
 * distinction is the whole reason this file exists.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpdExclusions, missingPatterns, verdictFor } from "./cpd-exclusions.mjs";

describe("reading the exclusions out of the properties file", () => {
  it("finds the patterns on the line, however many there are", () => {
    assert.deepEqual(cpdExclusions("sonar.cpd.exclusions=a/*.sql,b/**\nsonar.other=x"), [
      "a/*.sql",
      "b/**",
    ]);
  });

  it("tolerates spacing, because a human edits this file", () => {
    assert.deepEqual(cpdExclusions("  sonar.cpd.exclusions= a/*.sql , b/** "), ["a/*.sql", "b/**"]);
  });

  it("returns nothing when the setting is absent rather than guessing", () => {
    assert.deepEqual(cpdExclusions("sonar.sources=apps"), []);
  });

  it("is not fooled by a commented-out line", () => {
    // `#` starts a comment in a properties file, and this repository's copy is
    // mostly comments. A commented setting is not a setting.
    assert.deepEqual(cpdExclusions("# sonar.cpd.exclusions=a/*.sql"), []);
  });
});

describe("what the contract requires", () => {
  it("reports a required pattern that has been dropped", () => {
    // The circularity this exists to break: deriving the expectation from the
    // file alone means deleting a pattern also deletes its check, and the guard
    // then passes on the change it should catch.
    assert.deepEqual(missingPatterns(["scripts/mutations/**"]), ["packages/db/drizzle/*.sql"]);
  });

  it("is satisfied when both are present, in any order", () => {
    assert.deepEqual(missingPatterns(["scripts/mutations/**", "packages/db/drizzle/*.sql"]), []);
  });

  it("is not satisfied by something that merely contains the pattern", () => {
    // `packages/db/drizzle/*.sql.bak` is not the exclusion, and a substring
    // match would accept it.
    assert.deepEqual(missingPatterns(["packages/db/drizzle/*.sql.bak", "scripts/mutations/**"]), [
      "packages/db/drizzle/*.sql",
    ]);
  });
});

describe("whether a component satisfies the property", () => {
  const component = (ncloc, duplication) => ({
    measures: [
      { metric: "ncloc", value: String(ncloc) },
      { metric: "duplicated_lines_density", value: String(duplication) },
    ],
  });

  it("accepts a file that was analysed and reports no duplication", () => {
    assert.equal(verdictFor(component(130, 0)), null);
  });

  it("rejects a file that is not in the analysis at all", () => {
    // The `sonar.exclusions` failure. Duplication would be nil for the same
    // reason a deleted file's is nil, and only presence tells them apart.
    assert.match(verdictFor(undefined), /absent/);
  });

  it("accepts a file whose ncloc is legitimately zero", () => {
    // `0017_the_snapshot_catches_up.sql` is a migration that is deliberately
    // empty — its whole body is a comment explaining why, and CONTRIBUTING.md
    // holds it up as the worked example. Its `ncloc` is 0 because that is true,
    // not because it was not analysed.
    //
    // The first version of this check rejected it, and the guard's first run
    // against the real analysis is what found that. Reported-as-zero is a
    // measurement; not reported at all is an absence, and only the second is a
    // failure.
    assert.equal(verdictFor(component(0, 0)), null);
  });

  it("rejects a file that still contributes duplication", () => {
    assert.match(verdictFor(component(130, 81.6)), /81.6%.*not in force/);
  });

  it("rejects a file whose duplication was not reported", () => {
    // Absent measure and zero are different answers, and treating a missing one
    // as zero is how a check starts passing for files it never examined.
    assert.match(verdictFor({ measures: [{ metric: "ncloc", value: "130" }] }), /no duplication/);
  });

  it("rejects a file with no ncloc, which may not have been analysed", () => {
    assert.match(verdictFor({ measures: [] }), /no ncloc/);
  });
});
