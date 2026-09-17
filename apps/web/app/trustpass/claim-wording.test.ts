import { describe, expect, it } from "vitest";
import { describeCategory, describeClaim, describeStatus } from "./claim-wording";

/** Every claim-state pair the API can produce today. */
const PRODUCED_TODAY = [
  ["issuer", "verified"],
  ["issuer", "pending"],
  ["issuer", "unverified"],
  ["issuer", "suspended"],
  ["serial", "recorded"],
  ["secure_tag", "not_present"],
  ["warranty", "not_recorded"],
  ["physical_authenticity", "not_verifiable"],
] as const;

describe("describeClaim — every pair produced today is worded", () => {
  it.each(PRODUCED_TODAY)("%s / %s has a label and an explanation", (claim, state) => {
    const wording = describeClaim(claim, state);

    expect(wording.label).not.toBe("");
    expect(wording.label).not.toBe("Not described");
    expect(wording.detail).not.toBe("");
  });
});

describe("describeClaim — ADR 0003, in words", () => {
  it.each(PRODUCED_TODAY)("never calls anything authentic: %s / %s", (claim, state) => {
    // The one word the passport must never say about the product.
    const wording = describeClaim(claim, state);

    expect(`${wording.label} ${wording.detail}`).not.toMatch(/\bauthentic\b|\bgenuine product\b/i);
  });

  it("never words a recorded serial as verified", () => {
    const wording = describeClaim("serial", "recorded");

    expect(wording.label).not.toMatch(/verified/i);
    expect(wording.tone).not.toBe("positive");
  });

  it("never gives the physical product a reassuring tone", () => {
    expect(describeClaim("physical_authenticity", "not_verifiable").tone).not.toBe("positive");
  });

  it("says a verified issuer is a check of the company, not the product", () => {
    // Otherwise a green "Verified" row reads as a verdict on the object.
    expect(describeClaim("issuer", "verified").detail).toMatch(/not of this product/i);
  });

  it("marks an unverified issuer as a caution, not neutral", () => {
    expect(describeClaim("issuer", "unverified").tone).toBe("caution");
  });

  it("only ever uses a positive tone for a real verification", () => {
    for (const [claim, state] of PRODUCED_TODAY) {
      const { tone } = describeClaim(claim, state);
      if (tone === "positive") {
        expect(state).toBe("verified");
      }
    }
  });
});

describe("describeClaim — codes this page has not learned yet", () => {
  it("renders an unknown state neutrally, never positively", () => {
    // A state this page does not understand is not evidence of anything.
    expect(describeClaim("issuer", "certified_by_mars")).toEqual({
      subject: "Issuer",
      label: "Not described",
      tone: "neutral",
      detail: "",
    });
  });

  it("humanises an unknown claim subject rather than showing a raw code", () => {
    expect(describeClaim("battery_health", "recorded").subject).toBe("Battery health");
  });
});

describe("describeCategory and describeStatus", () => {
  it("names a known category", () => {
    expect(describeCategory("gpu")).toBe("Graphics card");
  });

  it("humanises an unknown category", () => {
    expect(describeCategory("smart_watch")).toBe("Smart watch");
  });

  it("marks a suspended product as negative", () => {
    expect(describeStatus("suspended")).toEqual({ label: "Suspended", tone: "negative" });
  });
});
