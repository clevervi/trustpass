/**
 * The guards on the QR route, which had none.
 *
 * #196 measured four mutations against `qr.svg/route.ts` with the whole
 * `apps/web` suite as the judge, and all four survived: the CSP could go, the
 * `nosniff` could go, a request-derived origin could be cached for a year, and
 * the length bound could be dropped. Every test stayed green.
 *
 * The reason was not negligence. `vitest.config.ts` had no alias for `@/`, so a
 * test could not import a route handler at all — the setup could not reach the
 * file it was supposed to cover.
 *
 * The third of these is the one with teeth. `cacheControlFor(origin)` replaced
 * by a literal `public, max-age=31536000, immutable` is cache poisoning: `Host`
 * is the caller's, and a shared cache would serve their host to everyone who
 * came after, under a URL that gets printed onto labels.
 */
export default {
  name: "qr-route",
  issue: 196,

  protects: ["apps/web/app/trustpass/[trustpassId]/qr.svg/route.ts"],

  runner: {
    cwd: "apps/web",
    command: ["pnpm", "exec", "vitest", "run", "app/trustpass/", "--reporter=dot"],
    nameFlag: "-t",
  },

  mutations: [
    {
      file: "apps/web/app/trustpass/[trustpassId]/qr.svg/route.ts",
      mutations: [
        {
          label: "the content security policy is removed",
          test: "refuses the document permission to do anything",
          from: `      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",\n`,
          to: "",
        },
        {
          label: "nosniff is removed",
          test: "tells the browser not to guess the type",
          from: `      "x-content-type-options": "nosniff",\n`,
          to: "",
        },
        {
          label: "a request-derived origin is cached for a year",
          test: "refuses to cache a response whose origin came from the request",
          from: '"cache-control": cacheControlFor(origin),',
          to: '"cache-control": "public, max-age=31536000, immutable",',
        },
        {
          label: "the cache header stops depending on the origin at all",
          test: "answers differently for the same identifier depending on the origin's source",
          from: '"cache-control": cacheControlFor(origin),',
          to: '"cache-control": "no-store",',
        },
        {
          label: "the length bound is dropped",
          test: "refuses an identifier longer than the API's own bound",
          from: "if (trustpassId.length === 0 || trustpassId.length > MAX_IDENTIFIER_LENGTH) {",
          to: "if (false) {",
        },
        {
          label: "the bound is narrowed until it refuses everything useful",
          test: "accepts one exactly at the bound, so the limit is the limit",
          from: "const MAX_IDENTIFIER_LENGTH = 64;",
          to: "const MAX_IDENTIFIER_LENGTH = 1;",
        },
        {
          // The route does not escape anything — `qrSvgDocument` does, and
          // `lib/qr.test.ts` covers that. What the route owns is that the
          // caller's identifier reaches the escaping path at all, so that is
          // what this breaks.
          //
          // The first attempt stripped entities from the description before it
          // was escaped, which is a no-op: there are no entities there yet. It
          // survived, correctly, and the mutation was wrong rather than the
          // test.
          label: "the identifier never reaches the described document",
          test: "escapes an identifier that would otherwise close the tag, through the route",
          from: "      `TrustPass passport ${trustpassId}`,",
          to: '      "TrustPass passport",',
        },
        {
          label: "an unknown origin answers 404 rather than 503",
          test: "does not cache the refusal when no origin can be established",
          from: "      status: 503,",
          to: "      status: 404,",
        },
      ],
    },
  ],
};
