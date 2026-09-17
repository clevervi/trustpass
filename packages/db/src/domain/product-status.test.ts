import { describe, expect, it } from "vitest";
import type { ProductStatus } from "../schema/product.js";
import {
  assertTransition,
  canTransition,
  IllegalProductStatusTransition,
  isTerminal,
  nextStatuses,
  PRODUCT_STATUS_TRANSITIONS,
} from "./product-status.js";

const ALL_STATUSES = Object.keys(PRODUCT_STATUS_TRANSITIONS) as ProductStatus[];

describe("canTransition", () => {
  it.each([
    ["draft", "registered"],
    ["draft", "retired"],
    ["registered", "active"],
    ["registered", "suspended"],
    ["registered", "retired"],
    ["active", "suspended"],
    ["active", "retired"],
    ["suspended", "registered"],
    ["suspended", "retired"],
  ] as const)("allows %s to %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(ALL_STATUSES)("allows %s to stay where it is", (status) => {
    // An update that changes a brand or a serial leaves the status alone.
    // Treating that as a transition would block every ordinary write.
    expect(canTransition(status, status)).toBe(true);
  });

  it.each([
    ["draft", "active"],
    ["draft", "suspended"],
    ["registered", "draft"],
    ["active", "draft"],
    ["active", "registered"],
    ["suspended", "draft"],
  ] as const)("refuses %s to %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe("suspension", () => {
  it("cannot go straight back to active", () => {
    // A product that quietly becomes active again erases the reason it was
    // suspended. Clearing a suspension is its own act.
    expect(canTransition("suspended", "active")).toBe(false);
  });

  it("clears through registered, which then allows activation", () => {
    expect(canTransition("suspended", "registered")).toBe(true);
    expect(canTransition("registered", "active")).toBe(true);
  });
});

describe("retirement", () => {
  it("is terminal", () => {
    expect(isTerminal("retired")).toBe(true);
    expect(nextStatuses("retired")).toEqual([]);
  });

  it.each(ALL_STATUSES)("cannot be left for %s", (target) => {
    if (target === "retired") {
      // Staying retired is not leaving it.
      expect(canTransition("retired", target)).toBe(true);
      return;
    }

    expect(canTransition("retired", target)).toBe(false);
  });

  it("is reachable from every other status", () => {
    // A product must always be able to reach end of life, or rows accumulate
    // in states nothing can clear.
    for (const status of ALL_STATUSES) {
      if (status === "retired") continue;
      expect(canTransition(status, "retired")).toBe(true);
    }
  });
});

describe("assertTransition", () => {
  it("passes a legal move through silently", () => {
    expect(() => assertTransition("draft", "registered")).not.toThrow();
  });

  it("throws an error naming both states", () => {
    expect(() => assertTransition("retired", "active")).toThrow(IllegalProductStatusTransition);
    expect(() => assertTransition("retired", "active")).toThrow(/from "retired" to "active"/);
  });

  it("carries both states as fields, not only in the message", () => {
    // An HTTP layer should not have to parse prose to report the states.
    try {
      assertTransition("suspended", "active");
      expect.fail("expected the illegal transition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalProductStatusTransition);
      expect((error as IllegalProductStatusTransition).from).toBe("suspended");
      expect((error as IllegalProductStatusTransition).to).toBe("active");
    }
  });
});

describe("the transition table itself", () => {
  it("covers every status as a source", () => {
    // A status missing from the table would throw on lookup rather than
    // returning false, turning a refusal into a crash.
    expect(Object.keys(PRODUCT_STATUS_TRANSITIONS).sort()).toEqual(
      ["active", "draft", "registered", "retired", "suspended"].sort(),
    );
  });

  it("names only statuses that exist", () => {
    for (const targets of Object.values(PRODUCT_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it("never lists a status as its own target", () => {
    // Staying put is handled explicitly in canTransition. Listing it here too
    // would make the table's meaning ambiguous.
    for (const [from, targets] of Object.entries(PRODUCT_STATUS_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });
});
