import { cacheControlFor, resolvePassportOrigin } from "@/lib/passport-origin";
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
  request: Request,
  { params }: { params: Promise<{ trustpassId: string }> },
) {
  const { trustpassId } = await params;

  if (trustpassId.length === 0 || trustpassId.length > MAX_IDENTIFIER_LENGTH) {
    return new Response("Not found", { status: 404 });
  }

  const origin = resolvePassportOrigin({ host: request.headers.get("host") });

  // 503 rather than 404: the passport exists, this deployment just cannot say
  // where it lives. A 404 would claim there is nothing here, and the caller
  // would cache that belief.
  if (origin.kind === "unknown") {
    return new Response("Passport origin is not configured; set NEXT_PUBLIC_SITE_URL.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  // Deliberately no lookup. A QR is an encoding of a URL, and the page that URL
  // points to already states honestly whether a passport exists. Checking here
  // would make printing a label depend on the API being reachable, and would
  // answer a question this route was not asked.
  let svg: string;
  try {
    svg = qrSvgDocument(
      encodeQr(passportUrl(trustpassId, origin.baseUrl)),
      `TrustPass passport ${trustpassId}`,
    );
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Decided by where the origin came from, not by this route.
      //
      // A configured origin is a pure function of the identifier in the URL and
      // can never change for it, so it is cached for a year — the opposite of
      // the passport page's `no-store`, because trust data changes and this
      // image does not.
      //
      // An origin derived from the request varies with `Host`, which the caller
      // controls. Caching that under this URL would serve a forged host to
      // everyone who came after, turning a development convenience into cache
      // poisoning.
      "cache-control": cacheControlFor(origin),
      // The SVG is generated here from a fixed template, but it is still served
      // as a document, and a document served from this origin can script.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
