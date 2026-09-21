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
import {
  asRevision,
  coveredFiles,
  cpdExclusions,
  matchesPattern,
  missingPatterns,
  verdictFor,
} from "./cpd-exclusions.mjs";

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

describe("which paths a pattern covers", () => {
  // Sonar's own rule, and the reason #202 could enlarge the population without
  // anybody noticing: the first version took the text before the first `*` as a
  // directory and matched on extension, which reads every pattern as `**`.
  it("matches a file directly under the directory a single star names", () => {
    assert.equal(
      matchesPattern("packages/db/drizzle/0001_first.sql", "packages/db/drizzle/*.sql"),
      true,
    );
  });

  it("stops a single star at a path separator", () => {
    assert.equal(
      matchesPattern("packages/db/drizzle/old/0001_first.sql", "packages/db/drizzle/*.sql"),
      false,
    );
  });

  it("carries a double star across path separators", () => {
    assert.equal(
      matchesPattern("scripts/mutations/nested/deep/set.mjs", "scripts/mutations/**"),
      true,
    );
  });

  it("treats the dot in an extension as a dot and not as any character", () => {
    // Unescaped, `*.sql` matches "aXsql" — which would put a file in the
    // population that the exclusion does not cover, and then demand it be
    // excluded.
    assert.equal(matchesPattern("packages/db/drizzle/aXsql", "packages/db/drizzle/*.sql"), false);
  });

  it("anchors at the start, so a path that merely contains the directory misses", () => {
    assert.equal(
      matchesPattern("vendor/packages/db/drizzle/0001.sql", "packages/db/drizzle/*.sql"),
      false,
    );
  });

  it("anchors at the end, so a longer suffix misses", () => {
    assert.equal(
      matchesPattern("packages/db/drizzle/0001.sql.bak", "packages/db/drizzle/*.sql"),
      false,
    );
  });

  it("does not match a file beside the directory a double star names", () => {
    assert.equal(matchesPattern("scripts/mutate.mjs", "scripts/mutations/**"), false);
  });
});

describe("the population the exclusions cover", () => {
  const tree = [
    "scripts/mutations/for-log.mjs",
    "README.md",
    "packages/db/drizzle/0001_first.sql",
    "packages/db/src/schema.ts",
    "scripts/mutations/cpd-exclusions.mjs",
  ];

  it("keeps only what a required pattern covers", () => {
    assert.deepEqual(coveredFiles(tree), [
      "packages/db/drizzle/0001_first.sql",
      "scripts/mutations/cpd-exclusions.mjs",
      "scripts/mutations/for-log.mjs",
    ]);
  });

  it("returns nothing for a tree that holds none of them", () => {
    // This is what feeds #199's empty-population failure. It must be reachable,
    // or that failure can never fire.
    assert.deepEqual(coveredFiles(["README.md", "apps/web/app/page.tsx"]), []);
  });

  it("is sorted, so the report reads the same on every platform", () => {
    const sorted = coveredFiles(tree);

    assert.deepEqual(sorted, [...sorted].sort());
  });
});

describe("what may be handed to git as a revision", () => {
  const objectName = "becb372f1a2b3c4d5e6f708192a3b4c5d6e7f809";

  it("accepts a full object name", () => {
    assert.equal(asRevision(objectName), objectName);
  });

  it("rejects a revision that git would read as an option", () => {
    // `jssecurity:S6350`. `execFileSync` spawns no shell, and git still parses
    // its own arguments — `--upload-pack=` names a command to run.
    assert.equal(asRevision("--upload-pack=touch owned"), null);
  });

  it("rejects an option that merely contains a full object name", () => {
    // The anchors are the guard. Unanchored, this passes and the leading
    // dashes reach git intact.
    assert.equal(asRevision(`--upload-pack=${objectName}`), null);
  });

  it("rejects a short object name, which git would otherwise resolve", () => {
    assert.equal(asRevision("becb372"), null);
  });

  it("rejects a value that is not a string at all", () => {
    // It comes out of a parsed HTTP response, so it can be absent or a number.
    assert.equal(asRevision(undefined), null);
    assert.equal(asRevision(null), null);
    assert.equal(asRevision(42), null);
  });
});
