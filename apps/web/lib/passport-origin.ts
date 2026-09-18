/**
 * Where a passport QR points.
 *
 * This is the only place that decides it, and the decision carries two risks
 * that pull in opposite directions.
 *
 * Guess wrong and the QR still scans — it simply resolves somewhere else, and
 * nobody finds out until a camera follows it. That argues for deriving the
 * origin from the request, which is always right for whoever is looking at the
 * page.
 *
 * But the `qr.svg` route caches immutably for a year, and the request's `Host`
 * header is attacker-controlled. A forged `Host` cached under that URL would
 * serve every later visitor a code pointing at the attacker. That argues for
 * trusting nothing but configuration.
 *
 * So both are used, and the resulting origin says which it was, because the
 * caller must cache a request-derived answer differently from a configured one.
 */

export type PassportOrigin =
  /** From `NEXT_PUBLIC_SITE_URL`. Independent of the request, so safe to cache. */
  | { readonly kind: "configured"; readonly baseUrl: string }
  /** Derived from this request's `Host`. Never cacheable, and never in production. */
  | { readonly kind: "request"; readonly baseUrl: string }
  /**
   * Unknown. No QR may be rendered.
   *
   * A passport with no QR is honest — everything else on the page is still
   * true. A passport with a QR to the wrong host is a lie printed on an object
   * that cannot be recalled.
   */
  | { readonly kind: "unknown" };

/**
 * A `Host` may carry a port but nothing else. Anything with a slash, a scheme,
 * whitespace, a comma or credentials is either a forgery attempt or a proxy
 * misconfiguration, and neither belongs in a URL printed on a product.
 */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

/**
 * Accepts only an absolute http(s) origin.
 *
 * A relative or malformed value would otherwise be concatenated into something
 * that looks like a URL and is not, which is exactly the silent-wrong-answer
 * this module exists to remove.
 */
function validConfiguredUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return trimSlash(value.trim());
  } catch {
    return undefined;
  }
}

export interface ResolveOriginOptions {
  /** This request's `Host` header, when there is a request. */
  readonly host?: string | null;
  /** `NEXT_PUBLIC_SITE_URL`. Passed in so tests need not mutate the environment. */
  readonly configured?: string | undefined;
  /** Whether this is a production build. */
  readonly isProduction?: boolean;
}

export function resolvePassportOrigin(options: ResolveOriginOptions = {}): PassportOrigin {
  const {
    host,
    configured = process.env.NEXT_PUBLIC_SITE_URL,
    isProduction = process.env.NODE_ENV === "production",
  } = options;

  const fromConfig = validConfiguredUrl(configured);
  if (fromConfig) {
    return { kind: "configured", baseUrl: fromConfig };
  }

  // Deliberately not a production fallback. In production an unset variable is
  // a deployment mistake, and the safe response to a deployment mistake is to
  // publish nothing rather than to publish a guess.
  if (isProduction) {
    return { kind: "unknown" };
  }

  if (host && HOST.test(host)) {
    // http, not https: this branch is development only, and a QR pointing at an
    // https origin that serves plain http fails to load rather than failing to
    // scan, which is harder to diagnose.
    return { kind: "request", baseUrl: `http://${host}` };
  }

  return { kind: "unknown" };
}

/**
 * What the `qr.svg` route may put in `Cache-Control`.
 *
 * A configured origin is a pure function of the identifier in the URL and can
 * never change for it, so it is cached for a year. A request-derived origin
 * varies with a header an attacker controls, and caching it under this URL
 * would serve that attacker's host to everyone who came after.
 */
export function cacheControlFor(origin: PassportOrigin): string {
  return origin.kind === "configured" ? "public, max-age=31536000, immutable" : "no-store";
}
