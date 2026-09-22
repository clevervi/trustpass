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
import {
  applyPatch,
  classify,
  flatten,
  nameSelector,
  ranNothing,
  selectSets,
  verdict,
} from "./mutate.mjs";

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

  it("selects a set when its own definition changed", () => {
    // The hole this runner's CI found in itself. The pull request that added
    // the `qr-route` set selected nothing: the set protects a route that pull
    // request did not touch, so a brand new set was introduced and never run,
    // and the check was green.
    //
    // A set nobody has executed is a claim, and replacing claims with runs is
    // the whole of #194.
    assert.deepEqual(
      selectSets(sets, ["scripts/mutations/one.mjs"]).map((set) => set.name),
      ["one"],
    );
  });

  it("does not select a set because some other set's definition changed", () => {
    // The match is on this set's own file, not on the directory. Otherwise
    // every set runs whenever any set is edited, and the selector stops being
    // a selector.
    assert.deepEqual(selectSets(sets, ["scripts/mutations/three.mjs"]), []);
  });

  it("matches a whole path rather than a prefix", () => {
    // `src/a.ts` must not be selected by `src/a.ts.bak` or by `other/src/a.ts`.
    // A prefix match would quietly run sets that have nothing to do with the
    // change, which is the cheap direction to be wrong in — and would also miss
    // the point of measuring the intersection at all.
    assert.deepEqual(selectSets(sets, ["src/a.ts.bak", "other/src/a.ts"]), []);
  });
});

describe("a selector means the name the set declared", () => {
  // #215. The flag takes a regular expression; a mutation declares a literal
  // name. The property is not "escape carets" — it is that a selector cannot
  // mean something other than the identity the set wrote down.
  const selects = (pattern, name) => new RegExp(pattern).test(name);

  it("selects a name containing a caret, which anchored to nothing before", () => {
    const name = "counts one IPv6 allocation as one caller, not as 2^64 of them";

    // The measurement that opened #215: the raw name is not a pattern that
    // matches itself.
    assert.equal(new RegExp(name).test(name), false);
    assert.equal(selects(nameSelector(name), name), true);
  });

  it("selects a name containing every metacharacter that would change its meaning", () => {
    for (const name of [
      "refuses $10 and nothing else",
      "reads a.b as one name",
      "accepts (only) the first",
      "handles [brackets] literally",
      "treats a+b as text",
      "asks whether it is there?",
      "takes a|b as one thing",
      "keeps a\\b intact",
      "ends at the end$",
      "starts ^here",
      "allows {braces}",
      "matches * exactly",
    ]) {
      assert.equal(selects(nameSelector(name), name), true, name);
    }
  });

  it("stops selecting a different test whose name differs by one character", () => {
    // The half escaping is really for. `a.b` as a pattern matches `axb`, so an
    // unescaped selector could run a neighbouring test and report a verdict
    // about it — which reads exactly like a working mutation.
    assert.equal(selects("reads a.b as one name", "reads axb as one name"), true);
    assert.equal(selects(nameSelector("reads a.b as one name"), "reads axb as one name"), false);
  });

  it("leaves an ordinary name alone", () => {
    const name = "answers 429 once the burst is spent";

    assert.equal(nameSelector(name), name);
  });
});

describe("a clean exit over an empty selection", () => {
  // The other half of #215, and the one that makes it silent: vitest exits 0
  // when a name filter matches nothing. Measured:
  //
  //   Test Files  4 skipped (4)
  //         Tests  89 skipped (89)
  //   exit: 0
  const SKIPPED = " Test Files  4 skipped (4)\n      Tests  89 skipped (89)\n";
  const PASSED = " Test Files  1 passed (1)\n      Tests  22 passed (22)\n";
  const MIXED = "      Tests  1 failed | 58 passed (59)\n";

  it("is not a pass, because no test was asked anything", () => {
    assert.equal(ranNothing(SKIPPED), true);
    assert.equal(classify(SKIPPED, 0), "no-such-test");
  });

  it("is still a pass when tests actually ran", () => {
    assert.equal(ranNothing(PASSED), false);
    assert.equal(classify(PASSED, 0), "pass");
  });

  it("counts a run that had failures as having run", () => {
    assert.equal(ranNothing(MIXED), false);
  });

  it("reads node --test's own summary", () => {
    assert.equal(ranNothing("ℹ pass 0\nℹ fail 0\n"), true);
    assert.equal(ranNothing("ℹ pass 22\nℹ fail 0\n"), false);
  });

  it("does not mistake a test's name for a summary line", () => {
    // The trap this file already fell into once, from the other direction: a
    // pattern that fires on prose. A name is indented inside a suite and never
    // begins a line with the runner's summary word.
    const green = `${PASSED}  ✓ Tests  0 passed is a phrase inside a test name\n`;

    assert.equal(ranNothing(green), false);
  });

  it("says nothing about a runner whose output it does not recognise", () => {
    // Answering "nothing ran" here would turn every unrecognised runner into a
    // refusal, which is a worse failure than the one being fixed.
    assert.equal(ranNothing("some other tool said something else entirely"), false);
    assert.equal(classify("some other tool said something else entirely", 0), "pass");
  });
});
