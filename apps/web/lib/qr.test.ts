import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { encodeQr, passportUrl, type QrCode, QrEncodingError, qrSvgDocument } from "./qr";

const TRUSTPASS_ID = "TP1-4C6V1TSVSEH70HNMC2N0WMSD3H8";

/**
 * Rebuilds the module grid from the path and hands it to an independent
 * decoder.
 *
 * The point of using `jsqr` rather than `qrcode-generator`'s own reader is that
 * a round trip through one library proves only that the library agrees with
 * itself. A separate implementation reading the pixels is the only test that
 * can fail when the encoder is wrong.
 *
 * No rasterisation is needed: one module becomes one pixel, and jsQR takes raw
 * RGBA. The quiet zone is already in the path offsets, so a decoder sees the
 * margin a real scanner needs.
 */
function decode(code: QrCode): string | null {
  const side = code.extent;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);

  for (const match of code.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const column = Number(match[1]);
    const row = Number(match[2]);
    const offset = (row * side + column) * 4;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
  }

  return jsQR(pixels, side, side)?.data ?? null;
}

describe("encodeQr — what a scanner actually reads", () => {
  it("produces a code that an independent decoder reads back as the URL given", () => {
    const url = passportUrl(TRUSTPASS_ID, "https://trustpass.example");

    expect(decode(encodeQr(url))).toBe(url);
  });

  it("round-trips a URL long enough to need a larger grid", () => {
    const url = passportUrl(TRUSTPASS_ID, `https://${"sub.".repeat(12)}trustpass.example`);
    const code = encodeQr(url);

    expect(decode(code)).toBe(url);
    expect(code.size).toBeGreaterThan(37);
  });

  it("leaves at least four blank modules on every side", () => {
    const code = encodeQr(passportUrl(TRUSTPASS_ID, "https://trustpass.example"));
    const coordinates = [...code.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((match) => ({
      column: Number(match[1]),
      row: Number(match[2]),
    }));

    // Four is the specification's minimum, asserted as the literal number
    // rather than against `code.quietZone`. Deriving the bound from the value
    // under test makes the assertion true for any margin including none, which
    // is exactly what an earlier version of this test did.
    const SPECIFIED_MINIMUM = 4;
    const columns = coordinates.map(({ column }) => column);
    const rows = coordinates.map(({ row }) => row);

    expect(Math.min(...columns, ...rows)).toBeGreaterThanOrEqual(SPECIFIED_MINIMUM);
    expect(code.extent - Math.max(...columns, ...rows) - 1).toBeGreaterThanOrEqual(
      SPECIFIED_MINIMUM,
    );
  });
});

describe("encodeQr — refusing to encode what it would corrupt", () => {
  // `qrcode-generator`'s default encoder keeps the low byte of each code unit,
  // so U+4E2D becomes `-`. It raises nothing and the code scans cleanly, to the
  // wrong address. A QR on a product that resolves somewhere else is worse than
  // no QR at all, so this must be an error and not a best effort.

  it.each([
    ["an accented character", "https://café.example/trustpass/TP1-ABC"],
    ["a CJK character", "https://trustpass.example/中"],
    ["an emoji", "https://trustpass.example/🎉"],
  ])("refuses %s", (_label, url) => {
    expect(() => encodeQr(url)).toThrow(QrEncodingError);
  });

  it("refuses empty input rather than encoding a code that means nothing", () => {
    expect(() => encodeQr("")).toThrow(QrEncodingError);
  });

  it("accepts the full printable ASCII range", () => {
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join("");

    expect(decode(encodeQr(printable))).toBe(printable);
  });
});

describe("qrSvgDocument", () => {
  const code = encodeQr(passportUrl(TRUSTPASS_ID, "https://trustpass.example"));

  it("is black on white regardless of the reader's colour scheme", () => {
    const svg = qrSvgDocument(code, "Passport");

    // An inverted QR is rejected by a large share of scanners, so this one
    // image must not follow the page's dark mode.
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).not.toMatch(/prefers-color-scheme|currentColor/);
  });

  it("declares the SVG namespace, so it renders when saved as a file", () => {
    expect(qrSvgDocument(code, "Passport")).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("escapes the description instead of letting it close the tag", () => {
    const svg = qrSvgDocument(code, 'ASUS "ROG" <script>alert(1)</script>');

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("carries a text alternative, because a QR is an image of a link", () => {
    const svg = qrSvgDocument(code, "Passport for TP1-ABC");

    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>Passport for TP1-ABC</title>");
  });
});

describe("passportUrl", () => {
  it("builds an absolute URL, because a camera has no page to be relative to", () => {
    expect(passportUrl(TRUSTPASS_ID, "https://trustpass.example")).toBe(
      `https://trustpass.example/trustpass/${TRUSTPASS_ID}`,
    );
  });

  it("does not double the separator when the base URL has a trailing slash", () => {
    expect(passportUrl(TRUSTPASS_ID, "https://trustpass.example/")).toBe(
      `https://trustpass.example/trustpass/${TRUSTPASS_ID}`,
    );
  });

  it("encodes the identifier into the path", () => {
    expect(passportUrl("a/../b", "https://trustpass.example")).toBe(
      "https://trustpass.example/trustpass/a%2F..%2Fb",
    );
  });

  it("reads no environment variable and has no default host", () => {
    // The defect this replaced: with NEXT_PUBLIC_SITE_URL unset, every code
    // encoded http://localhost:3000 wherever the app was actually served, and
    // scanned perfectly to whatever else held that port. Deciding the origin is
    // a question about the request and the deployment; a pure function cannot
    // see either, so it must not guess.
    const previous = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://from-the-environment.example";

    try {
      expect(passportUrl(TRUSTPASS_ID, "https://given.example")).toBe(
        `https://given.example/trustpass/${TRUSTPASS_ID}`,
      );
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = previous;
    }
  });
});
