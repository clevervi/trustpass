import { describe, expect, it } from "vitest";
import { issuerVerificationStatus } from "../schema/issuer.js";
import { CLAIM_STATES, CLAIM_SUBJECTS, computeVerificationClaims } from "./verification-claims.js";

const EVERY_ISSUER_STATUS = issuerVerificationStatus.enumValues;

describe("computeVerificationClaims", () => {
  it.each(EVERY_ISSUER_STATUS)("reports an issuer that is %s as exactly that", (status) => {
    const claims = computeVerificationClaims({ issuerVerificationStatus: status });

    expect(claims.find((claim) => claim.claim === "issuer")?.state).toBe(status);
  });

  it.each(EVERY_ISSUER_STATUS)(
    "returns every subject, in ADR 0003's reading order, for an issuer that is %s",
    (status) => {
      // The page renders in array order, so the order is part of the contract.
      const claims = computeVerificationClaims({ issuerVerificationStatus: status });

      expect(claims.map((claim) => claim.claim)).toEqual([...CLAIM_SUBJECTS]);
    },
  );

  it.each(EVERY_ISSUER_STATUS)(
    "only ever uses known states, for an issuer that is %s",
    (status) => {
      for (const claim of computeVerificationClaims({ issuerVerificationStatus: status })) {
        expect(CLAIM_STATES).toContain(claim.state);
      }
    },
  );
});

describe("ADR 0003 — identity is not authenticity", () => {
  it.each(EVERY_ISSUER_STATUS)(
    "never reports the serial as verified, even for an issuer that is %s",
    (status) => {
      // The issuer supplied the serial and nothing compared it to the object.
      // "Verified" here is the lie this project exists not to tell.
      const serial = computeVerificationClaims({ issuerVerificationStatus: status }).find(
        (claim) => claim.claim === "serial",
      );

      expect(serial?.state).toBe("recorded");
    },
  );

  it.each(EVERY_ISSUER_STATUS)(
    "always reports physical authenticity as not verifiable, for an issuer that is %s",
    (status) => {
      const physical = computeVerificationClaims({ issuerVerificationStatus: status }).find(
        (claim) => claim.claim === "physical_authenticity",
      );

      expect(physical?.state).toBe("not_verifiable");
    },
  );

  it("never makes every claim verified, even for the most trusted issuer", () => {
    // If a combination of inputs could turn the whole list green, a page could
    // render it as an authenticity badge without saying a false word.
    const claims = computeVerificationClaims({ issuerVerificationStatus: "verified" });

    expect(claims.every((claim) => claim.state === "verified")).toBe(false);
    expect(claims.filter((claim) => claim.state === "verified")).toHaveLength(1);
  });
});
