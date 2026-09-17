import { encodeQr, passportUrl, qrSvgDocument } from "@/lib/qr";

/**
 * The passport's QR as a file, for an issuer who needs one to print.
 *
 * The page renders the same code inline, from the same function. This route
 * exists only so a label workflow has something to download.
 */

/**
 * Matches the API's path-parameter bound. A QR grows with its input, so an
 * unbounded identifier is an invitation to ask this route for a very large
 * image many times.
 */
const MAX_IDENTIFIER_LENGTH = 64;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ trustpassId: string }> },
) {
  const { trustpassId } = await params;

  if (trustpassId.length === 0 || trustpassId.length > MAX_IDENTIFIER_LENGTH) {
    return new Response("Not found", { status: 404 });
  }

  // Deliberately no lookup. A QR is an encoding of a URL, and the page that URL
  // points to already states honestly whether a passport exists. Checking here
  // would make printing a label depend on the API being reachable, and would
  // answer a question this route was not asked.
  let svg: string;
  try {
    svg = qrSvgDocument(encodeQr(passportUrl(trustpassId)), `TrustPass passport ${trustpassId}`);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // The opposite of the passport page's `no-store`, and deliberately so.
      // The passport is never cached because trust data changes — a suspended
      // product must read as suspended immediately. This image is a pure
      // function of the identifier in the URL and can never change for it.
      "cache-control": "public, max-age=31536000, immutable",
      // The SVG is generated here from a fixed template, but it is still served
      // as a document, and a document served from this origin can script.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
