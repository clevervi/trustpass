import { describe, expect, it } from "vitest";
import { discloseSerial } from "./serial-disclosure.js";

describe("discloseSerial", () => {
  it.each([
    ["two characters, the shortest the schema allows", "AB"],
    ["four characters, where 'the last four' is everything", "ABCD"],
    ["seven characters", "ABCDEFG"],
    ["eight characters, where 'the last four' is exactly half", "ABCDEFGH"],
  ])("reveals nothing for %s", (_label, serial) => {
    expect(discloseSerial(serial)).toEqual({ disclosed: false });
  });

  it("reveals the last four once more characters stay hidden than are shown", () => {
    expect(discloseSerial("ABCDEFGHI")).toEqual({
      disclosed: true,
      suffix: "FGHI",
      hiddenCharacters: 5,
    });
  });

  it("reports how many characters are withheld on a realistic serial", () => {
    expect(discloseSerial("M1LMCS004896")).toEqual({
      disclosed: true,
      suffix: "4896",
      hiddenCharacters: 8,
    });
  });

  it("measures the serial after trimming", () => {
    // Eight characters padded to twelve must not cross the threshold.
    expect(discloseSerial("  ABCDEFGH  ")).toEqual({ disclosed: false });
    expect(discloseSerial("  M1LMCS004896 ")).toMatchObject({
      suffix: "4896",
      hiddenCharacters: 8,
    });
  });

  it("counts code points, so a multi-byte character is never split", () => {
    // Each emoji is two UTF-16 units. Slicing by string length would cut one in
    // half and render a replacement character on a public page.
    const result = discloseSerial("SN-2026-🔒🔒🔒🔒");

    expect(result).toEqual({ disclosed: true, suffix: "🔒🔒🔒🔒", hiddenCharacters: 8 });
  });

  it.each(["AB", "ABCDEFGH", "ABCDEFGHI", "M1LMCS004896", "SERIAL-NUMBER-0000000001"])(
    "never returns the whole serial: %s",
    (serial) => {
      // The regression this function exists to prevent, asserted for every
      // shape of input rather than argued.
      expect(JSON.stringify(discloseSerial(serial))).not.toContain(serial);
    },
  );
});
