/**
 * The sanitiser two scripts now share.
 *
 * It had no tests while it was private to `merge-bar.mjs`, which is part of why
 * a second copy was nearly written instead of it being reused: an untested
 * private helper is easier to rewrite than to trust.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forLog } from "./for-log.mjs";

describe("what reaches a log", () => {
  it("leaves an ordinary value alone", () => {
    assert.equal(forLog("Test against Postgres"), "Test against Postgres");
  });

  it("stops a newline fabricating a line", () => {
    // The whole point. `jssecurity:S5145`: a value carrying a newline lets
    // whoever set it write its own entry into a log somebody trusts.
    assert.equal(forLog("ok\nrequired check: nothing"), "ok required check: nothing");
  });

  it("removes a carriage return, which overwrites a line rather than adding one", () => {
    assert.equal(forLog("real\rfake"), "real fake");
  });

  it("removes an escape, which a terminal would act on", () => {
    // Colour codes and cursor movement are a terminal instruction, not text.
    const escaped = `${String.fromCodePoint(0x1b)}[31mred`;

    assert.equal(forLog(escaped), " [31mred");
  });

  it("removes delete, which sits above the control range", () => {
    // 0x7f is not below 0x20 and is still not printable. A range check written
    // as "below 0x20" alone would let it through.
    assert.equal(forLog(`a${String.fromCodePoint(0x7f)}b`), "a b");
  });

  it("keeps a non-ASCII character, because it is text and not a control", () => {
    assert.equal(forLog("señal — ok"), "señal — ok");
  });

  it("bounds the length, so one value cannot fill the log", () => {
    assert.equal(forLog("x".repeat(500)).length, 120);
  });

  it("accepts something that is not a string at all", () => {
    // It is called on API values and on parsed file contents, either of which
    // can be a number, null, or absent.
    assert.equal(forLog(42), "42");
    assert.equal(forLog(null), "null");
    assert.equal(forLog(undefined), "undefined");
  });
});
