import { describe, expect, it } from "vitest";
import { describeClaim, describeHistoryEntry, describeOrigin } from "./claim-wording";

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

describe("an origin says where a record began, never that a product is genuine", () => {
  // The most reassuring value on the whole passport. A reader weighs everything
  // else against it, so it has to say what it actually means.

  it("does not turn a manufacturer origin into proof about the object", () => {
    const { label, detail } = describeOrigin("manufacturer");

    expect(label).toBe("Started by the manufacturer");
    expect(detail).toContain("does not confirm");
    expect(`${label} ${detail}`.toLowerCase()).not.toMatch(/\b(genuine|authentic|verified)\b/);
  });

  it.each(["manufacturer", "supply_chain", "holder"])(
    "describes %s without claiming authenticity",
    (origin) => {
      const { label, detail } = describeOrigin(origin);

      expect(label).not.toBe(origin);
      expect(detail.length).toBeGreaterThan(0);
      expect(`${label} ${detail}`.toLowerCase()).not.toMatch(/\bauthentic\b/);
    },
  );

  it("says a holder origin establishes only that a serial was entered", () => {
    // It is not provenance, not ownership, and not evidence about the object —
    // and it must not be mistakable for a manufacturer record.
    expect(describeOrigin("holder").detail).toContain("nothing about where the product came from");
  });

  it("does not present an unrecognised origin as reassuring", () => {
    const { label, detail } = describeOrigin("customs_seizure");

    expect(label).toBe("Customs seizure");
    expect(detail).toBe("TrustPass does not have a description for this kind of record.");
  });
});

describe("no issuer is not an unverified issuer", () => {
  it("says there is no company rather than one nobody checked", () => {
    const wording = describeClaim("issuer", "not_present");

    expect(wording.detail).toContain("No business registered this product");
    expect(wording.detail).toContain("not the same as a company nobody has checked");
    expect(wording.tone).toBe("neutral");
  });

  it("does not reuse the unverified wording", () => {
    // The unverified copy says "Nobody has checked this company", which asserts
    // a company exists. For a holder enrolment none does.
    expect(describeClaim("issuer", "not_present").detail).not.toBe(
      describeClaim("issuer", "unverified").detail,
    );
  });
});

describe("wording that must hold for a record with no issuer", () => {
  it("does not say an issuer supplied the serial", () => {
    // A holder-enrolled record has no issuer, so attributing the serial to one
    // invents a party the record does not have — the same mistake as reporting
    // a missing issuer as an unverified one.
    expect(describeClaim("serial", "recorded").detail).not.toMatch(/\bthe issuer\b/i);
  });

  it("still says nothing has compared the serial to the object", () => {
    // The part that must survive any rewording.
    expect(describeClaim("serial", "recorded").detail).toContain(
      "nothing has compared it to the object",
    );
  });
});
