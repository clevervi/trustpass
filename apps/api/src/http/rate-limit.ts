import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthenticatedPrincipal } from "@trustpass/db";
import type { Context, MiddlewareHandler } from "hono";
import { ApiErrorCode } from "./errors.js";

/**
 * How expensive it is to ask the same question a thousand times.
 *
 * `POST /enrolments` answers whether a serial already has a live record, and
 * #120 establishes why that cannot be hidden on an unauthenticated write
 * endpoint: a write endpoint that will not say whether the write happened is
 * unusable, and one that lies about it is worse. The identifier is gone —
 * that part closed — and what remains is a yes-or-no per serial at one request
 * each.
 *
 * This is the other half of #120's answer: not removing the signal, but making
 * a sweep cost something. A serial range off a product line is thousands of
 * guesses, and thousands of guesses at four an hour is not an afternoon.
 *
 * **It is not a defence against a determined attacker** and nothing here should
 * be read as one. It raises the price of enumeration from free to slow, and the
 * signal itself closes when enrolling requires being somebody, which is #141.
 */

/**
 * A token bucket, rather than a fixed window.
 *
 * A fixed window lets twice the limit through across a boundary — 20 requests
 * at 11:59:59 and 20 more at 12:00:00 — which for an enumeration guard means
 * the attacker who notices gets double throughput for free. A bucket has no
 * boundary to sit on.
 */
export interface RateLimit {
  /** How many requests can arrive at once before the rate starts to bind. */
  readonly burst: number;
  /** The sustained rate, once the burst is spent. */
  readonly perSecond: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until one more request would be allowed. `0` when allowed. */
  readonly retryAfter: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * The decision, separated from HTTP and from the clock.
 *
 * Pure enough to test a hundred thousand requests in a millisecond, which is
 * what a rate limiter's tests actually need to do. A middleware that owned its
 * own clock could only be tested by waiting.
 */
export function createRateLimiter(limit: RateLimit, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();

  /** How long a spent bucket takes to refill completely. */
  const fullRefillMs = (limit.burst / limit.perSecond) * 1000;

  /**
   * Sweeps callers who have been quiet long enough to have refilled.
   *
   * **Not evaluated on the caller making the request**, which is what the first
   * version did — it asked whether the bucket was full *after* spending a
   * token, which it never can be, so nothing was ever dropped and the eviction
   * was decoration. Its own test caught that.
   *
   * A bucket that has refilled holds no information: it is indistinguishable
   * from a caller who has never been seen. Dropping it loses nothing, and not
   * dropping it lets an attacker varying source addresses grow this map without
   * bound — a guard against enumeration turned into a way to exhaust the
   * process.
   *
   * Lazy, past a threshold, rather than on a timer. A timer keeps the process
   * awake to tidy a map that is usually empty.
   */
  function prune(at: number): void {
    for (const [key, bucket] of buckets) {
      if (at - bucket.lastRefill >= fullRefillMs) {
        buckets.delete(key);
      }
    }
  }

  /** Small enough that pruning is cheap, large enough that it is rare. */
  const PRUNE_ABOVE = 1_000;

  return {
    check(key: string): RateLimitDecision {
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: limit.burst, lastRefill: at };

      const elapsed = Math.max(0, at - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(limit.burst, bucket.tokens + elapsed * limit.perSecond);
      bucket.lastRefill = at;

      if (bucket.tokens < 1) {
        buckets.set(key, bucket);

        if (buckets.size > PRUNE_ABOVE) {
          prune(at);
        }

        return {
          allowed: false,
          // Ceiling, so a client that obeys it does not come back a
          // millisecond early and get refused again.
          retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / limit.perSecond)),
        };
      }

      bucket.tokens -= 1;
      buckets.set(key, bucket);

      if (buckets.size > PRUNE_ABOVE) {
        prune(at);
      }

      return { allowed: true, retryAfter: 0 };
    },

    /** For tests, and for a log line that says how much is being tracked. */
    size: () => buckets.size,

    /** Exposed so a test can show the sweep works without pushing past the threshold. */
    prune,
  };
}

/**
 * What a caller is identified by, and what it deliberately is not.
 *
 * The socket's remote address, never `X-Forwarded-For`. That header is set by
 * whoever is calling, so a limiter keyed on it is one an attacker switches off
 * by varying a string — a guard that reads like safety and is a formality.
 *
 * This repository already holds that position for `Host`: the QR origin is
 * never taken from the request in production, "because the `Host` header is
 * caller-controlled and the QR response is cached for a year". The same
 * reasoning, and the same refusal to make the trusting choice the default.
 *
 * The cost is that behind a reverse proxy every caller shares one address and
 * the limit applies to all of them together. That is the safe direction to be
 * wrong in — too strict rather than trivially bypassed — and the day this runs
 * behind a proxy, trusting a forwarded header becomes a deliberate
 * configuration with a named trusted hop, not a default.
 */
export function callerAddress(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address;

    return address ? bucketKey(address) : SHARED_BUCKET;
  } catch {
    // No socket to ask. `getConnInfo` needs the Node server's bindings, and a
    // request built in a test — or served by an adapter that does not provide
    // them — has none.
    //
    // Everybody then shares one bucket, which is the strict direction: too
    // restrictive rather than trivially bypassed, matching the choice made
    // above about the forwarded header. It is not free — one caller can spend
    // the shared allowance and the others wait — so it is a degradation rather
    // than a mode, and the safe one to degrade into for an endpoint whose
    // limit exists to stop enumeration.
    return SHARED_BUCKET;
  }
}

/** The key everybody falls back to when no address can be established. */
const SHARED_BUCKET = "unidentified";

/**
 * Collapses an address to the unit a limit should actually apply to.
 *
 * Keying on the address exactly as the socket reports it looks right and is
 * not, for two reasons found by running the real server rather than by reading
 * the code:
 *
 * **The same IPv4 address arrives written two ways.** A dual-stack listener
 * reports `::ffff:127.0.0.1` where a v4-only one reports `127.0.0.1` —
 * measured, both from the same machine. They are one address, so they are one
 * bucket, and without this a change of listener silently re-keys everybody.
 *
 * **An IPv6 client is not given one address, it is given a /64.** A residential
 * allocation is a /64 or wider, so keying on the full address hands a single
 * attacker 2^64 buckets: the limit would be bypassed by incrementing a number,
 * which is no limit at all against the one attacker it exists for. Keying on
 * the /64 is what a limit on "a caller" means when the caller speaks IPv6.
 *
 * ponytail: the /64 is the common allocation, not a rule. A provider handing
 * out /56s puts 256 of them behind one customer, and a provider handing out
 * /128s makes this stricter than it needs to be. Fixed prefix rather than a
 * lookup because the alternative is shipping a routing table; the upgrade path
 * is a configured prefix length, not a cleverer default.
 */
export function bucketKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);

  if (mapped) return mapped[1] as string;
  if (!address.includes(":")) return address;

  // A zone index (`fe80::1%eth0`) needs no handling of its own. It names an
  // interface on this host rather than the caller, and it is always written on
  // the last group — which the truncation below discards. Stripping it was
  // written first and removed: a mutation proved nothing depended on it.
  return `${groupsOf(address).slice(0, 4).map(canonicalGroup).join(":")}::/64`;
}

/**
 * One group, written the one way.
 *
 * `2001:0DB8:…` and `2001:db8:…` are the same address, and without this they are
 * two buckets. Node hands over the canonical form today, so nothing reaches this
 * in the wrong shape — which is exactly the argument that was wrong about
 * `::ffff:`. An exported function that takes a string does not get to assume its
 * caller.
 */
function canonicalGroup(group: string): string {
  return group.replace(/^0+(?=.)/, "").toLowerCase();
}

/**
 * The eight groups of an IPv6 address, with `::` put back.
 *
 * Taking the first four groups of the text would be wrong for every compressed
 * address: `::1` reads as `0:0:0:0:0:0:0:1`, and its first four groups are
 * zeroes, not `:`, `:` and `1`.
 */
function groupsOf(address: string): readonly string[] {
  if (!address.includes("::")) return address.split(":");

  const [head = "", tail = ""] = address.split("::");
  const before = head ? head.split(":") : [];
  const after = tail ? tail.split(":") : [];

  return [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill("0"), ...after];
}

/**
 * Who the allowance belongs to.
 *
 * The actor when the request carries one, and the address otherwise. #120 asks
 * for this in as many words — *"keyed on more than the address — NAT puts real
 * users behind one"* — and a limit keyed on the address alone fails both
 * directions at once: an office behind one NAT shares an allowance none of them
 * spent, and an attacker with more than one address never meets it.
 *
 * **Not the actor *and* the address.** A composite key gives a caller a fresh
 * allowance for every address they appear from, which is a rate limit that
 * rewards exactly the behaviour it exists to stop. The actor alone binds a
 * credential to one allowance wherever it is presented from.
 *
 * **The address path is unreachable from any route this application has**, and
 * that is worth stating rather than leaving to be discovered. `requireCredential`
 * is registered on `/products` and `/enrolments` before this is, and it answers
 * 401 without calling the next handler, so a request that reaches here always
 * carries a principal. Everything below `callerAddress` — the shared-bucket
 * degradation, the mapped-IPv4 collapse, the /64 — is exercised by tests and by
 * nothing else.
 *
 * So the honest claim is not "the limiter normalises IPv6". It is that the
 * normalisation exists, is covered, and protects a caller that no current route
 * produces. Whether to keep a fallback with no production caller is a real
 * question and #189 holds it; it is kept here because a middleware does not get
 * to assume where it is mounted, and because the failure it prevents — an IPv6
 * client holding 2^64 buckets — is precisely what someone re-adding address
 * keying in a hurry would reintroduce.
 */
export function callerKey(c: Context): string {
  // Typed as always present by the module declaration in `authenticate.ts`,
  // because every handler behind that middleware does have one. This is the
  // middleware layer, where that is a claim about registration order rather
  // than a fact, so widen it and check.
  const principal: AuthenticatedPrincipal | undefined = c.get("principal");

  // Prefixed so the two spaces cannot meet: actor 1 and a caller at the address
  // "1" are not the same caller, however unlikely that address is.
  return principal ? `actor:${principal.actorId}` : `address:${callerAddress(c)}`;
}

/**
 * Refuses, identically, whatever was being asked for.
 *
 * The body carries no serial, no identifier and nothing about the request, for
 * the same reason the 409 does not: a response is the only thing a sweep gets
 * to look at, and a rate limit that reported *what* it was limiting would hand
 * back the detail the limit exists to protect.
 */
export function rateLimited(
  limit: RateLimit,
  now?: () => number,
  key: (c: Context) => string = callerKey,
): MiddlewareHandler {
  const limiter = createRateLimiter(limit, now);

  return async (c, next) => {
    const decision = limiter.check(key(c));

    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfter));

      return c.json(
        {
          error: ApiErrorCode.TOO_MANY_REQUESTS,
          message: "Too many requests. Try again shortly.",
        },
        429,
      );
    }

    await next();
  };
}
