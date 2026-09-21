/**
 * The runner's own guards.
 *
 * A mutation harness that cannot tell a caught mutant from one that merely
 * failed to compile produces a table of results it never measured. That is not
 * hypothetical: the scratch harness this replaces did exactly that, reported
 * `caught` for a mutant that did not build, and the row sat in a pull request
 * body looking like evidence.
 *
 * So the pieces that decide are separated from the pieces that spawn, and these
 * are the deciding pieces.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPatch, classify, flatten, selectSets, verdict } from "./mutate.mjs";

describe("why a test run ended", () => {
  it("reads an assertion failure as an assertion failure", () => {
    assert.equal(
      classify("AssertionError [ERR_ASSERTION]: expected 429 to be 201", 1),
      "failed-assertion",
    );
  });

  it("does not read a mutant that will not compile as a caught guard", () => {
    // The failure that made the scratch harness lie. A renamed identifier, a
    // non-zero exit, and a row that said `caught`.
    assert.equal(classify("error TS2304: Cannot find name 'address'.", 1), "broken-build");
    assert.equal(classify("SyntaxError: Unexpected token", 1), "broken-build");
  });

  it("separates a red run that is neither of those", () => {
    // A timeout, a crash, a missing fixture. Not evidence either way, and
    // calling it a catch would be the same mistake with a different cause.
    assert.equal(classify("Error: connect ECONNREFUSED 127.0.0.1:5432", 1), "failed-other");
  });

  it("refuses to read a filter that matched nothing as a pass", () => {
    // Exits non-zero and proves nothing. A renamed test would otherwise look
    // like a guard that stopped being checked, or like one that never was.
    assert.equal(classify("No test files found, exiting with code 1", 1), "no-such-test");
    assert.equal(classify("ℹ tests 0\nℹ pass 0", 1), "no-such-test");
  });

  it("reads a zero exit as a pass whatever the output says", () => {
    assert.equal(classify("some log line mentioning AssertionError in prose", 0), "pass");
  });

  it("is not fooled by a test name that contains its own signal words", () => {
    // Found by the runner's mutation set, against this file. The first version
    // checked for the word `matched` before it checked the exit code, and this
    // suite contains a test called "refuses to read a filter that matched
    // nothing as a pass". A green run was classified as having matched no
    // tests, and the set that checks the runner could not get a baseline.
    //
    // Every rule in `classify` reads prose, and prose contains whatever a test
    // is called. The exit code does not.
    const green = "✔ refuses to read a filter that matched nothing as a pass\nℹ pass 16";

    assert.equal(classify(green, 0), "pass");
  });
});

describe("what a mutation proved", () => {
  it("counts a mutant the assertion caught", () => {
    assert.equal(verdict("failed-assertion", "pass"), "caught");
  });

  it("does not count a mutant that never built", () => {
    assert.equal(verdict("broken-build", "pass"), "invalid");
  });

  it("does not count a mutant whose test was already failing", () => {
    // Without this, a broken suite reports every mutation as caught and the set
    // looks healthiest at the moment it stops meaning anything.
    assert.equal(verdict("failed-assertion", "failed-assertion"), "already-red");
  });

  it("says a mutant survived when the test stayed green", () => {
    assert.equal(verdict("pass", "pass"), "survived");
  });
});

describe("applying a patch", () => {
  it("refuses when the anchor has moved", () => {
    // The ordinary result of a refactor. Reported rather than silently treated
    // as a surviving mutant, which would accuse a working test.
    assert.deepEqual(applyPatch("const a = 1;", { from: "const b", to: "x" }), {
      problem: "anchor-missing",
    });
  });

  it("refuses a patch that changes nothing", () => {
    assert.deepEqual(applyPatch("const a = 1;", { from: "const a", to: "const a" }), {
      problem: "no-op",
    });
  });

  it("replaces the first occurrence and leaves the rest", () => {
    assert.deepEqual(applyPatch("a a a", { from: "a", to: "b" }), { patched: "b a a" });
  });
});

describe("flattening a set's file groups", () => {
  it("gives every mutation the file its group names", () => {
    const flat = flatten([
      { file: "a.ts", mutations: [{ label: "one" }, { label: "two" }] },
      { file: "b.ts", mutations: [{ label: "three" }] },
    ]);

    assert.deepEqual(flat, [
      { label: "one", file: "a.ts" },
      { label: "two", file: "a.ts" },
      { label: "three", file: "b.ts" },
    ]);
  });

  it("does not let a mutation override the group it is in", () => {
    // A stray `file:` inside a mutation would otherwise patch a file the set
    // does not declare — and the set's declared files are what the selector
    // reads, so the mutation would run on a diff that never mentioned it.
    const flat = flatten([{ file: "a.ts", mutations: [{ label: "one", file: "elsewhere.ts" }] }]);

    assert.equal(flat[0]?.file, "a.ts");
  });

  it("produces nothing from a group with no mutations", () => {
    assert.deepEqual(flatten([{ file: "a.ts", mutations: [] }]), []);
  });
});

describe("which sets a diff selects", () => {
  const sets = [
    { name: "one", protects: ["src/a.ts", "src/b.ts"] },
    { name: "two", protects: ["scripts/c.mjs"] },
  ];

  it("selects a set whose file the diff touches", () => {
    assert.deepEqual(
      selectSets(sets, ["src/b.ts", "README.md"]).map((set) => set.name),
      ["one"],
    );
  });

  it("selects nothing when the diff touches nothing a set names", () => {
    // The case that has to be visible rather than silent: the pull request is
    // green and no guard was checked. The runner prints it; this asserts the
    // selector is honest about producing it.
    assert.deepEqual(selectSets(sets, ["docs/ROADMAP.md"]), []);
  });

  it("selects every set a diff spans", () => {
    assert.deepEqual(
      selectSets(sets, ["src/a.ts", "scripts/c.mjs"]).map((set) => set.name),
      ["one", "two"],
    );
  });

  it("matches a whole path rather than a prefix", () => {
    // `src/a.ts` must not be selected by `src/a.ts.bak` or by `other/src/a.ts`.
    // A prefix match would quietly run sets that have nothing to do with the
    // change, which is the cheap direction to be wrong in — and would also miss
    // the point of measuring the intersection at all.
    assert.deepEqual(selectSets(sets, ["src/a.ts.bak", "other/src/a.ts"]), []);
  });
});
