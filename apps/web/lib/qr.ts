import qrcode from "qrcode-generator";

/**
 * QR encoding for passport URLs.
 *
 * A QR code is discovery, not security. Per ADR 0003 it proves only that
 * someone had the code — it can be photographed from a marketplace listing and
 * reprinted onto any object. Nothing in the passport may treat a successful
 * scan as evidence about the physical product.
 */

/**
 * Error correction level.
 *
 * `M` recovers about 15% of a damaged code. `Q` recovers 25% but needs a denser
 * grid, which matters when the label is printed small on a graphics card shroud
 * or a phone's back panel. The trade is worth taking here because a QR that
 * will not scan is not a dead end: ADR 0004 gives every TrustPass ID a check
 * symbol precisely so a human can read the code off the label and type it in.
 */
const ERROR_CORRECTION = "M";

/** Automatic: the smallest grid that fits the data. */
const AUTOMATIC_SIZE = 0;

/**
 * Modules of blank margin. Four is the specification's minimum, and scanners
 * genuinely fail without it — the quiet zone is how a decoder finds the edges.
 */
const QUIET_ZONE = 4;

export interface QrCode {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  /** Modules of margin on each side. */
  readonly quietZone: number;
  /** The side of the whole code including both margins, in module units. */
  readonly extent: number;
  /**
   * An SVG path `d` in module units, already offset by the quiet zone.
   *
   * A path rather than a grid of rectangles: one element instead of several
   * hundred, and the caller can hand it to a React `<path>` element without
   * `dangerouslySetInnerHTML`.
   */
  readonly path: string;
}

export class QrEncodingError extends Error {}

/**
 * `qrcode-generator`'s default byte encoder is latin-1: it keeps the low byte
 * of each code unit and discards the rest. `"中"` (U+4E2D) becomes byte 0x2D,
 * which is `-`. No error is raised, and the resulting code scans perfectly —
 * to a different URL than the one requested.
 *
 * A passport URL is ASCII by construction (a host plus a Crockford base32
 * identifier), so the only way to get here is a misconfigured base URL. Failing
 * loudly is the whole point: a QR on a product that resolves somewhere else is
 * worse than no QR.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Encodes text as a QR code. Throws rather than encode something it would corrupt. */
export function encodeQr(text: string): QrCode {
  if (!PRINTABLE_ASCII.test(text)) {
    throw new QrEncodingError(
      "A QR code can only be built from printable ASCII: this encoder would silently corrupt anything else.",
    );
  }

  const code = qrcode(AUTOMATIC_SIZE, ERROR_CORRECTION);
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const segments: string[] = [];

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (code.isDark(row, column)) {
        segments.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
  }

  return {
    size,
    quietZone: QUIET_ZONE,
    extent: size + QUIET_ZONE * 2,
    path: segments.join(""),
  };
}

/**
 * The same code as a standalone SVG document, for an issuer who needs a file to
 * print.
 *
 * Black on white, hardcoded, in both colour schemes. An inverted QR — light
 * modules on a dark background — is rejected by a large share of scanners, so
 * this one image must not follow the page's theme.
 */
export function qrSvgDocument(code: QrCode, description: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${code.extent} ${code.extent}"`,
    ` width="${code.extent * 8}" height="${code.extent * 8}" shape-rendering="crispEdges"`,
    ` role="img" aria-label="${escapeXml(description)}">`,
    `<title>${escapeXml(description)}</title>`,
    `<rect width="${code.extent}" height="${code.extent}" fill="#fff"/>`,
    `<path d="${code.path}" fill="#000"/>`,
    "</svg>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The absolute URL a passport QR resolves to.
 *
 * Absolute because a QR is scanned by a camera that has no page to be relative
 * to. `NEXT_PUBLIC_SITE_URL` is read here rather than at module load so a test
 * can set it, and it falls back to localhost so the code is scannable in
 * development instead of pointing at a host that does not exist yet.
 */
export function passportUrl(trustpassId: string, baseUrl?: string): string {
  const base = baseUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/trustpass/${encodeURIComponent(trustpassId)}`;
}
