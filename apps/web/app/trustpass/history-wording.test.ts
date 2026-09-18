import { describe, expect, it } from "vitest";
import { describeHistoryEntry } from "./claim-wording";

/**
 * Every reason the API can send, so a new one cannot be added without this
 * suite noticing that nobody wrote words for it.
 */
const REASONS = [
  "theft_report",
  "fraud_flag",
  "counterfeit_report",
  "ownership_dispute",
  "warranty_dispute",
  "investigation_closed",
  "dispute_resolved",
  "issuer_request",
  "holder_request",
  "warranty_replacement",
  "end_of_life",
  "recording_error",
] as const;

const TYPES = [
  "record_enrolled",
  "product_registered",
  "product_suspended",
  "product_reinstated",
  "product_retired",
  "record_corrected",
] as const;

describe("a history entry reports; it never concludes", () => {
  // The whole risk of this section. An event records that somebody reported a
  // change (ADR 0008); rendering it as an established fact is ADR 0003's
  // failure reached through the history instead of through a badge, and it
  // accuses a seller on the strength of one unverified filing.

  it("never says a product was stolen, only that a theft was reported", () => {
    const wording = describeHistoryEntry("product_suspended", "theft_report", "authority");

    expect(wording.because).toBe("a theft was reported");
    expect(`${wording.title} ${wording.because}`.toLowerCase()).not.toMatch(/\bstolen\b/);
  });

  it.each([
    ["counterfeit_report", /\bcounterfeit\b(?! concern)/],
    ["fraud_flag", /\bfraudulent\b/],
    ["ownership_dispute", /\bnot the owner\b/],
  ])("states %s as a report rather than a finding", (reason, verdict) => {
    const wording = describeHistoryEntry("product_suspended", reason, "authority");

    expect(wording.because).not.toMatch(verdict);
  });

  it.each(REASONS)("has words for %s", (reason) => {
    const wording = describeHistoryEntry("product_suspended", reason, "authority");

    // Falling through to the humanised code would render "Theft report" — not
    // wrong, but not written by anyone either, and the point of this module is
    // that every public sentence was chosen.
    expect(wording.because).not.toBe(reason.replace(/_/g, " "));
    expect(wording.because.length).toBeGreaterThan(0);
  });

  it.each(TYPES)("has a title for %s", (type) => {
    expect(describeHistoryEntry(type, null, "issuer").title).not.toBe(type);
  });

  it("colours a suspension as caution, never as a negative finding", () => {
    // A red badge would do with styling what the wording refuses to do with
    // words: turn a report into a verdict before anyone verified it.
    expect(describeHistoryEntry("product_suspended", "theft_report", "authority").tone).toBe(
      "caution",
    );
  });
});

describe("an unrecognised entry is rendered neutrally", () => {
  it("humanises a type the page has never seen", () => {
    const wording = describeHistoryEntry("ownership_transferred", null, "holder");

    expect(wording.title).toBe("Ownership transferred");
    expect(wording.tone).toBe("neutral");
  });

  it("does not present an unknown reason as worse than it is", () => {
    const wording = describeHistoryEntry("product_retired", "some_future_reason", "system");

    expect(wording.because).toBe("some future reason");
    expect(wording.tone).toBe("neutral");
  });

  it("names an unknown actor capacity rather than dropping it", () => {
    // Dropping it would render "Recorded by ." — and an entry with no actor is
    // worse than one naming a capacity this page does not know.
    expect(describeHistoryEntry("product_retired", null, "repairer").actor).toBe("Repairer");
  });
});

describe("an actor is a capacity, not a person", () => {
  it.each([
    ["issuer", "the issuer"],
    ["holder", "whoever held the product"],
    ["authority", "an authority"],
    ["system", "TrustPass"],
  ])("describes %s", (actorKind, expected) => {
    expect(describeHistoryEntry("product_registered", null, actorKind).actor).toBe(expected);
  });

  it("carries no reason clause when there is no reason", () => {
    expect(describeHistoryEntry("product_registered", null, "issuer").because).toBe("");
  });
});
