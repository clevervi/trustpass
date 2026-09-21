/**
 * The guards that make a sweep of the serial range cost something.
 *
 * #120 establishes that `POST /enrolments` cannot stop answering whether a
 * serial has a live record — a write endpoint that will not say whether the
 * write happened is unusable. What changed is the price, and these are the
 * eighteen ways that price could quietly stop being charged.
 *
 * Every mutation below was run when #188 was written and every one was caught by
 * an assertion, not by a build failure. This file is that run, made repeatable.
 */
export default {
  name: "write-rate-limit",
  issue: 120,

  /**
   * What a diff has to touch for this set to be selected.
   *
   * The two files the guards live in. Deliberately not every file the limiter
   * depends on: a list that tried to be complete would be wrong in a way nobody
   * could see, and the scheduled run is what covers what this misses.
   */
  protects: ["apps/api/src/app.ts", "apps/api/src/http/rate-limit.ts"],

  runner: {
    cwd: "apps/api",
    command: ["pnpm", "exec", "vitest", "run", "src/http/", "--reporter=dot"],
    nameFlag: "-t",
  },

  mutations: [
    {
      label: "the limiter is not registered at all",
      test: "answers 429 once the burst is spent",
      file: "apps/api/src/app.ts",
      from: '  app.use("/products", limited);\n  app.use("/enrolments", limited);',
      to: "",
    },
    {
      label: "registered on /enrolments only",
      test: "limits the other write endpoint too",
      file: "apps/api/src/app.ts",
      from: '  app.use("/products", limited);\n',
      to: "",
    },
    {
      label: "the 429 body echoes what was asked for",
      test: "refuses identically whichever endpoint was being written to",
      file: "apps/api/src/http/rate-limit.ts",
      from: '          message: "Too many requests. Try again shortly.",',
      to: "          message: `Too many requests for ${c.req.url}.`,",
    },
    {
      label: "the 429 body names the caller",
      test: "refuses two different actors with the same bytes",
      file: "apps/api/src/http/rate-limit.ts",
      from: '          message: "Too many requests. Try again shortly.",',
      to: "          message: `Too many requests from ${key(c)}.`,",
    },
    {
      label: "registered before the credential check",
      test: "refuses an unauthenticated caller before spending anybody's allowance",
      file: "apps/api/src/app.ts",
      from: "  const credentialed = requireCredential(deps.authenticate);",
      to: '  const preLimited = rateLimited(rateLimit);\n  app.use("/enrolments", preLimited);\n  const credentialed = requireCredential(deps.authenticate);',
    },
    {
      label: "the public read is limited too",
      test: "does not limit the public read, which a scanned QR depends on",
      file: "apps/api/src/app.ts",
      from: '  app.use("/products", limited);',
      to: '  app.use("*", limited);\n  app.use("/products", limited);',
    },
    {
      label: "the /64 collapse is dropped",
      test: "counts one IPv6 allocation as one caller, not as 2^64 of them",
      file: "apps/api/src/http/rate-limit.ts",
      from: '  return `${groupsOf(address).slice(0, 4).map(canonicalGroup).join(":")}::/64`;',
      to: "  return address;",
    },
    {
      label: "the collapse takes the text's first four groups",
      test: "reads a compressed address as the address it means",
      file: "apps/api/src/http/rate-limit.ts",
      from: '  if (!address.includes("::")) return address.split(":");',
      to: '  return address.split(":");\n  if (false) return address.split(":");',
    },
    {
      label: "the mapped prefix is not stripped",
      test: "treats a mapped IPv4 address and a plain one as the same caller",
      file: "apps/api/src/http/rate-limit.ts",
      from: "  if (mapped) return mapped[1] as string;",
      to: "",
    },
    {
      label: "the prefix is widened past one allocation",
      test: "keeps separate allocations separate",
      file: "apps/api/src/http/rate-limit.ts",
      from: '  return `${groupsOf(address).slice(0, 4).map(canonicalGroup).join(":")}::/64`;',
      to: '  return `${groupsOf(address).slice(0, 2).map(canonicalGroup).join(":")}::/32`;',
    },
    {
      label: "the group spelling is taken as given",
      test: "reads one address written two ways as one caller",
      file: "apps/api/src/http/rate-limit.ts",
      from: '  return group.replace(/^0+(?=.)/, "").toLowerCase();',
      to: "  return group;",
    },
    {
      label: "keyed on the address instead of the actor",
      test: "keeps two actors apart even though they share an address",
      file: "apps/api/src/http/rate-limit.ts",
      from: "  return principal ? `actor:${principal.actorId}` : `address:${callerAddress(c)}`;",
      to: "  return `address:${callerAddress(c)}`;",
    },
    {
      label: "keyed on the credential instead of the actor",
      test: "gives one actor one allowance however many credentials they hold",
      file: "apps/api/src/http/rate-limit.ts",
      from: "  return principal ? `actor:${principal.actorId}` : `address:${callerAddress(c)}`;",
      to: "  return principal ? `cred:${principal.credentialId}` : `address:${callerAddress(c)}`;",
    },
    {
      label: "the actor is joined to the address instead of replacing it",
      test: "charges an authenticated caller to the actor and to nothing else",
      file: "apps/api/src/http/rate-limit.ts",
      from: "  return principal ? `actor:${principal.actorId}` : `address:${callerAddress(c)}`;",
      to: "  return principal ? `actor:${principal.actorId}|${callerAddress(c)}` : `address:${callerAddress(c)}`;",
    },
    {
      label: "the two key spaces lose their prefixes",
      test: "falls back to the address, and says which space the key is in",
      file: "apps/api/src/http/rate-limit.ts",
      from: "  return principal ? `actor:${principal.actorId}` : `address:${callerAddress(c)}`;",
      to: "  return principal ? String(principal.actorId) : callerAddress(c);",
    },
    {
      label: "the shipping limit is widened to a million",
      test: "limits an app built the way the process builds it",
      file: "apps/api/src/app.ts",
      from: "export const WRITE_RATE_LIMIT = { burst: 20, perSecond: 0.2 } as const;",
      to: "export const WRITE_RATE_LIMIT = { burst: 1_000_000, perSecond: 1_000_000 } as const;",
    },
    {
      label: "the sustained rate is raised, burst untouched",
      test: "makes a sweep of ten thousand serials take hours rather than seconds",
      file: "apps/api/src/app.ts",
      from: "export const WRITE_RATE_LIMIT = { burst: 20, perSecond: 0.2 } as const;",
      to: "export const WRITE_RATE_LIMIT = { burst: 20, perSecond: 50 } as const;",
    },
    {
      label: "the burst is narrowed, sustained rate untouched",
      test: "limits an app built the way the process builds it",
      file: "apps/api/src/app.ts",
      from: "export const WRITE_RATE_LIMIT = { burst: 20, perSecond: 0.2 } as const;",
      to: "export const WRITE_RATE_LIMIT = { burst: 5, perSecond: 0.2 } as const;",
    },
  ],
};
