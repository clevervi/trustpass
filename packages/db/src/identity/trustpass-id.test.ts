import { describe, expect, it } from "vitest";
import { generateTrustPassId, isTrustPassId, parseTrustPassId } from "./trustpass-id.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CANONICAL = /^TP1-[0-9A-HJKMNP-TV-Z]{26}[0-9A-HJKMNP-TV-Z*~$=U]$/;

function bodyOf(id: string): string {
  return id.slice(4, 30);
}

function rebuild(id: string, body: string): string {
  return `TP1-${body}${id.slice(30)}`;
}

describe("generateTrustPassId", () => {
  it("produces the canonical format", () => {
    expect(generateTrustPassId()).toMatch(CANONICAL);
  });

  it("produces identifiers that parse back to themselves", () => {
    const id = generateTrustPassId();
    const parsed = parseTrustPassId(id);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.id).toBe(id);
  });

  it("does not repeat across a large sample", () => {
    const sample = new Set(Array.from({ length: 20_000 }, generateTrustPassId));

    expect(sample.size).toBe(20_000);
  });

  it("does not encode a monotonic or time-ordered value", () => {
    // Sorting must not reproduce generation order: an identifier that sorts
    // chronologically leaks when a product was issued and narrows a search.
    const generated = Array.from({ length: 200 }, generateTrustPassId);

    expect([...generated].sort()).not.toEqual(generated);
  });
});

describe("parseTrustPassId — transcription tolerance", () => {
  const id = generateTrustPassId();

  it("accepts lower case", () => {
    expect(parseTrustPassId(id.toLowerCase())).toEqual({ ok: true, id });
  });

  it("accepts surrounding whitespace and internal spacing", () => {
    const spaced = `  ${id.slice(0, 10)} ${id.slice(10, 20)} ${id.slice(20)}  `;

    expect(parseTrustPassId(spaced)).toEqual({ ok: true, id });
  });

  it("accepts the identifier without its separator", () => {
    expect(parseTrustPassId(id.replace("-", ""))).toEqual({ ok: true, id });
  });

  it.each([
    ["I read as 1", "I", "1"],
    ["l read as 1", "l", "1"],
    ["O read as 0", "O", "0"],
  ])("folds %s", (_label, typed, intended) => {
    const body = bodyOf(id);
    const position = body.indexOf(intended);

    // Only meaningful when the sampled identifier actually contains the symbol.
    if (position === -1) {
      return;
    }

    const mistyped = body.slice(0, position) + typed + body.slice(position + 1);

    expect(parseTrustPassId(rebuild(id, mistyped))).toEqual({ ok: true, id });
  });
});

describe("parseTrustPassId — rejection", () => {
  const id = generateTrustPassId();

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["TP1-ABC", "invalid_length"],
    [`${id}EXTRA`, "invalid_length"],
  ])("rejects %j as %s", (input, error) => {
    expect(parseTrustPassId(input)).toEqual({ ok: false, error });
  });

  it("rejects an unknown prefix", () => {
    expect(parseTrustPassId(`XP1-${bodyOf(id)}${id.slice(30)}`)).toEqual({
      ok: false,
      error: "invalid_prefix",
    });
  });

  it("rejects a format version this build does not implement", () => {
    expect(parseTrustPassId(`TP2-${bodyOf(id)}${id.slice(30)}`)).toEqual({
      ok: false,
      error: "unsupported_version",
    });
  });

  it("rejects a symbol outside the encoding alphabet", () => {
    const body = `U${bodyOf(id).slice(1)}`;

    expect(parseTrustPassId(rebuild(id, body))).toEqual({
      ok: false,
      error: "invalid_symbol",
    });
  });

  it("rejects a corrupted check symbol", () => {
    const wrongCheck = id.slice(30) === "0" ? "1" : "0";

    expect(parseTrustPassId(`${id.slice(0, 30)}${wrongCheck}`)).toEqual({
      ok: false,
      error: "checksum_mismatch",
    });
  });
});

describe("parseTrustPassId — single-symbol substitution", () => {
  it("detects every possible single-symbol typo in the body", () => {
    // The check symbol is computed modulo 37, a prime larger than the 32-symbol
    // alphabet. A single substitution shifts the value by delta * 32^position
    // with 0 < |delta| < 32, and neither factor is divisible by 37, so the
    // remainder must change. This asserts that property exhaustively rather
    // than trusting the argument.
    for (const id of Array.from({ length: 5 }, generateTrustPassId)) {
      const body = bodyOf(id);

      for (let position = 0; position < body.length; position += 1) {
        const original = body.charAt(position);

        for (const replacement of ALPHABET) {
          if (replacement === original) {
            continue;
          }

          const mutated = body.slice(0, position) + replacement + body.slice(position + 1);
          const result = parseTrustPassId(rebuild(id, mutated));

          expect(result, `${id} position ${position} -> ${replacement}`).toEqual({
            ok: false,
            error: "checksum_mismatch",
          });
        }
      }
    }
  });
});

describe("isTrustPassId", () => {
  it("accepts a generated identifier", () => {
    expect(isTrustPassId(generateTrustPassId())).toBe(true);
  });

  it("rejects an arbitrary string", () => {
    expect(isTrustPassId("not-a-trustpass-id")).toBe(false);
  });
});
