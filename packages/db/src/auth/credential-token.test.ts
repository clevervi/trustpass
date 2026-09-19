import { describe, expect, it } from "vitest";
import {
  digestOf,
  digestsMatch,
  ENVIRONMENTS,
  issueToken,
  parseToken,
  TOKEN_PREFIX,
} from "./credential-token.js";

/**
 * The half of authentication that touches no database.
 *
 * Parsing is where a token of the wrong shape, the wrong environment or the
 * wrong length has to stop, and it is also where a mistake is invisible: a
 * verifier that accepts a malformed value and then fails to find it in the
 * database looks identical from outside, right up until the day the two stop
 * agreeing about what "malformed" means.
 */

const LIVE = "live" as const;

/** The one place the wire format is spelled out in the tests. */
function token(environment: string, handle: string, secret: string): string {
  return `${TOKEN_PREFIX}.${environment}.${handle}.${secret}`;
}

describe("issueToken", () => {
  it("produces a token that parses back to its own parts", () => {
    const issued = issueToken(LIVE);
    const parsed = parseToken(issued.token, LIVE);

    expect(parsed?.handle).toBe(issued.handle);
    expect(issued.token.startsWith(`${TOKEN_PREFIX}.${LIVE}.`)).toBe(true);
  });

  it("parses back every token it issues, not most of them", () => {
    // This test found a real defect and is kept at full size because of it.
    //
    // The first format was `tp_live_<handle>_<secret>` — and `_` is IN the
    // base64url alphabet (`A-Z a-z 0-9 - _`). A secret containing one split
    // into five parts and was refused by its own parser. 481 of 1000 measured.
    //
    // A single round-trip passes half the time, which reads as a flaky test
    // rather than as a format that cannot read itself. So: many, and an
    // assertion that the sample actually contained the dangerous character,
    // because a loop that got lucky 500 times would otherwise prove nothing.
    const issued = Array.from({ length: 500 }, () => issueToken(LIVE));

    for (const credential of issued) {
      expect(parseToken(credential.token, LIVE)?.handle).toBe(credential.handle);
    }

    const payload = (credential: (typeof issued)[number]) =>
      credential.token.split(".").slice(2).join("");

    expect(issued.some((credential) => payload(credential).includes("_"))).toBe(true);
    expect(issued.some((credential) => payload(credential).includes("-"))).toBe(true);
  });

  it("stores a digest and never the secret", () => {
    const issued = issueToken(LIVE);
    const secret = issued.token.split(".")[3] as string;

    // The one property the whole storage decision rests on.
    expect(issued.digest.toString("hex")).not.toContain(secret);
    expect(digestsMatch(digestOf(secret), issued.digest)).toBe(true);
  });

  it("does not repeat itself", () => {
    // Not a test of the generator's quality — that is `randomBytes`' problem.
    // It catches the mistake of seeding once and reusing, which looks fine in
    // every other test because every other test issues one.
    const tokens = new Set(Array.from({ length: 200 }, () => issueToken(LIVE).token));

    expect(tokens.size).toBe(200);
  });

  it("binds to one environment", () => {
    for (const environment of ENVIRONMENTS) {
      const issued = issueToken(environment);

      expect(parseToken(issued.token, environment)).not.toBeNull();

      for (const other of ENVIRONMENTS.filter((candidate) => candidate !== environment)) {
        expect(parseToken(issued.token, other)).toBeNull();
      }
    }
  });
});

describe("parseToken refuses, without saying why", () => {
  const live = issueToken(LIVE);
  const [, , handle, secret] = live.token.split(".");

  const REFUSED: readonly (readonly [string, string | undefined])[] = [
    ["nothing presented", undefined],
    ["an empty string", ""],
    ["no structure at all", "hello"],
    ["the wrong prefix", token("live", handle as string, secret as string).replace("tp.", "xx.")],
    ["the wrong environment", token("staging", handle as string, secret as string)],
    ["too few parts", `${TOKEN_PREFIX}.live.${handle}`],
    ["too many parts", `${token("live", handle as string, secret as string)}.extra`],
    ["a short handle", token("live", "abc", secret as string)],
    ["a short secret", token("live", handle as string, "abc")],
    [
      "a handle with characters base64url does not use",
      token("live", "+".repeat(11), secret as string),
    ],
    [
      "a secret with characters base64url does not use",
      token("live", handle as string, "/".repeat(43)),
    ],
    ["the old underscore format", `${TOKEN_PREFIX}_live_${handle}_${secret}`],
  ];

  for (const [label, presented] of REFUSED) {
    it(`refuses ${label}`, () => {
      expect(parseToken(presented, LIVE)).toBeNull();
    });
  }

  it("returns the same answer for every one of them", () => {
    // `null` and not a reason. A caller that learns "wrong environment" rather
    // than "no" has learned which environments exist and what they hold — the
    // oracle #143 removed from /enrolments, and there is no reason to put one
    // back at the door.
    const answers = new Set(
      REFUSED.map(([, presented]) => JSON.stringify(parseToken(presented, LIVE))),
    );

    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe("null");
  });

  it("does not truncate a secret at a delimiter", () => {
    // The reason the part count is exact rather than "at least four". Splitting
    // loosely would compare a prefix of the secret and call it a match.
    expect(parseToken(`${live.token}.${secret}`, LIVE)).toBeNull();
  });

  it("accepts a payload containing every character base64url uses", () => {
    // The inverse of the defect above: `-` and `_` are legal payload content
    // and must survive parsing, which they only do while nothing splits on them.
    const crafted = token("live", `_-${"a".repeat(9)}`, `_-${"b".repeat(41)}`);

    expect(parseToken(crafted, LIVE)?.handle).toBe(`_-${"a".repeat(9)}`);
  });
});

describe("digestsMatch", () => {
  it("matches a digest to itself", () => {
    expect(digestsMatch(digestOf("a"), digestOf("a"))).toBe(true);
  });

  it("refuses a different secret", () => {
    expect(digestsMatch(digestOf("a"), digestOf("b"))).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    // `timingSafeEqual` throws when the lengths differ, and a thrown error
    // inside a verifier is an answer — usually a 500, which is distinguishable
    // from a 401 and therefore an oracle.
    expect(digestsMatch(Buffer.from("short"), digestOf("a"))).toBe(false);
  });
});
