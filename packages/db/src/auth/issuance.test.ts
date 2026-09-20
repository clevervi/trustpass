import { describe, expect, it } from "vitest";
import { canDeliverSecret, parseIssuanceArgs, REFUSAL } from "./issuance.js";

/**
 * The barriers, before the command that has to satisfy them.
 *
 * ADR 0014 §8 decided that issuance happens off the API, in a terminal, and
 * that the secret is shown once. Every refusal here exists because a secret
 * reaching a file, a log or a CI transcript is the failure this command is
 * designed around — and this repository has already had a live API key pasted
 * into a transcript and needing rotation.
 *
 * Each refusal carries its own reason. "It exited non-zero" is not an
 * assertion: a command that refuses for the wrong reason looks identical.
 */

describe("canDeliverSecret", () => {
  it("allows an interactive terminal with no CI marker", () => {
    expect(canDeliverSecret({ isTTY: true, env: {} })).toBeNull();
  });

  it("refuses when stdout is not a terminal", () => {
    // The one the first draft of the ADR missed. Writing to stdout is not the
    // same as being uncapturable: `db:issue-credential > token.txt` and
    // `TOKEN=$(db:issue-credential)` both work perfectly, and both put a
    // secret somewhere it was never meant to be.
    expect(canDeliverSecret({ isTTY: false, env: {} })).toBe(REFUSAL.NOT_A_TERMINAL);
  });

  it("refuses when CI is set, even with a terminal attached", () => {
    // Some CI runners do allocate a TTY. The variable closes what the TTY
    // check does not, and the two are checked separately because either alone
    // leaves a gap.
    expect(canDeliverSecret({ isTTY: true, env: { CI: "true" } })).toBe(
      REFUSAL.CONTINUOUS_INTEGRATION,
    );
  });

  it("treats any non-empty CI value as CI", () => {
    // Not `=== "true"`. Runners set it to `1`, `yes`, `True` and the name of
    // the provider, and a check that only knows one spelling is a check that
    // passes on the runner that matters.
    for (const value of ["1", "yes", "True", "woodpecker", "0"]) {
      expect(canDeliverSecret({ isTTY: true, env: { CI: value } })).toBe(
        REFUSAL.CONTINUOUS_INTEGRATION,
      );
    }
  });

  it("ignores CI when it is present but empty", () => {
    // An empty variable is how a shell unsets one in practice, and refusing on
    // it would make the command unusable in a terminal that happens to export
    // an empty CI. The refusal is for a runner, not for a spelling.
    expect(canDeliverSecret({ isTTY: true, env: { CI: "" } })).toBeNull();
  });
});

describe("parseIssuanceArgs", () => {
  const ok = ["--actor", "7", "--label", "nightly importer"];

  it("reads an existing actor and a label", () => {
    expect(parseIssuanceArgs(ok)).toEqual({
      label: "nightly importer",
      actor: { existing: 7 },
    });
  });

  it("reads a request to create the actor instead", () => {
    // The case a fresh deployment needs. There are no actors after
    // `db:reset`, so `--actor <id>` has nothing to point at and the command
    // would refuse every id — which is why this exists rather than the
    // operator writing an INSERT by hand.
    expect(
      parseIssuanceArgs(["--create-actor", "service", "nightly importer", "--label", "first key"]),
    ).toEqual({
      label: "first key",
      actor: { create: { kind: "service", displayName: "nightly importer" } },
    });
  });

  const REFUSED: readonly (readonly [string, string[], string])[] = [
    ["no actor at all", ["--label", "x y"], REFUSAL.NO_ACTOR],
    [
      "both an id and a creation",
      ["--actor", "7", "--create-actor", "service", "n", "--label", "x y"],
      REFUSAL.AMBIGUOUS_ACTOR,
    ],
    [
      "an actor that is not a number",
      ["--actor", "seven", "--label", "x y"],
      REFUSAL.ACTOR_NOT_AN_ID,
    ],
    ["an actor id of zero", ["--actor", "0", "--label", "x y"], REFUSAL.ACTOR_NOT_AN_ID],
    ["a negative actor id", ["--actor", "-3", "--label", "x y"], REFUSAL.ACTOR_NOT_AN_ID],
    ["a fractional actor id", ["--actor", "7.5", "--label", "x y"], REFUSAL.ACTOR_NOT_AN_ID],
    ["no label", ["--actor", "7"], REFUSAL.NO_LABEL],
    ["a blank label", ["--actor", "7", "--label", "   "], REFUSAL.LABEL_TOO_SHORT],
    ["a one-character label", ["--actor", "7", "--label", "x"], REFUSAL.LABEL_TOO_SHORT],
    [
      "an actor kind the schema does not have",
      ["--create-actor", "wizard", "n", "--label", "x y"],
      REFUSAL.UNKNOWN_ACTOR_KIND,
    ],
    ["a flag nobody defined", [...ok, "--force"], REFUSAL.UNKNOWN_ARGUMENT],
    ["an actor flag with no value", ["--actor", "--label", "x y"], REFUSAL.MISSING_VALUE],
    ["a label flag with no value", ["--actor", "7", "--label"], REFUSAL.MISSING_VALUE],
    [
      "a creation missing its name",
      ["--create-actor", "service", "--label", "x y"],
      REFUSAL.MISSING_VALUE,
    ],
  ];

  for (const [label, argv, reason] of REFUSED) {
    it(`refuses ${label}`, () => {
      expect(parseIssuanceArgs(argv)).toEqual({ refused: reason });
    });
  }

  it("refuses a label the database would refuse anyway, before reaching it", () => {
    // `credential_label_not_blank` requires `length(trim(label)) >= 2`. Letting
    // the database raise it would work and would report a constraint name to
    // somebody holding a terminal, which is a worse answer than the command
    // saying what it wanted.
    expect(parseIssuanceArgs(["--actor", "7", "--label", " a "])).toEqual({
      refused: REFUSAL.LABEL_TOO_SHORT,
    });
  });

  it("keeps a label that only needs trimming", () => {
    expect(parseIssuanceArgs(["--actor", "7", "--label", "  nightly importer  "])).toEqual({
      label: "nightly importer",
      actor: { existing: 7 },
    });
  });
});
