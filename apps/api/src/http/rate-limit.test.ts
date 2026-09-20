import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { WRITE_RATE_LIMIT } from "../app.js";
import { bucketKey, callerKey, createRateLimiter } from "./rate-limit.js";

/**
 * The decision, tested without HTTP and without waiting.
 *
 * A rate limiter's interesting cases are all about time, so a test that used
 * the real clock could only assert the ones that happen within a millisecond.
 * The clock is a parameter, which is why a hundred thousand requests below cost
 * nothing.
 */
describe("what a token bucket allows", () => {
  /** A clock the test moves on purpose. */
  function clock(start = 1_000_000) {
    let at = start;

    return { now: () => at, advance: (seconds: number) => (at += seconds * 1000) };
  }

  it("allows the burst and then refuses", () => {
    const time = clock();
    const limiter = createRateLimiter({ burst: 5, perSecond: 1 }, time.now);

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check("a").allowed).toBe(true);
    }

    expect(limiter.check("a").allowed).toBe(false);
  });

  it("refills at the rate it says, and not faster", () => {
    const time = clock();
    const limiter = createRateLimiter({ burst: 5, perSecond: 1 }, time.now);

    for (let index = 0; index < 5; index += 1) limiter.check("a");

    time.advance(0.9);
    expect(limiter.check("a").allowed).toBe(false);

    time.advance(0.1);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("does not refill past the burst, however long it waits", () => {
    // Otherwise an attacker banks capacity by going quiet, and comes back with
    // a thousand requests in hand.
    const time = clock();
    const limiter = createRateLimiter({ burst: 5, perSecond: 1 }, time.now);

    time.advance(86_400);

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check("a").allowed).toBe(true);
    }

    expect(limiter.check("a").allowed).toBe(false);
  });

  it("has no boundary to sit on, which a fixed window would", () => {
    // A fixed window lets 2×limit through across a boundary: spend the window
    // at the end of one and the whole allowance again at the start of the next.
    // Over any single second, this allows burst + perSecond and no more.
    const time = clock();
    const limiter = createRateLimiter({ burst: 10, perSecond: 10 }, time.now);

    let allowed = 0;

    // One second, in tenths, asking twice as often as the rate.
    for (let tick = 0; tick < 20; tick += 1) {
      if (limiter.check("a").allowed) allowed += 1;
      time.advance(0.05);
    }

    expect(allowed).toBeLessThanOrEqual(20);
    expect(allowed).toBeGreaterThan(10);
  });

  it("keeps callers apart", () => {
    const time = clock();
    const limiter = createRateLimiter({ burst: 2, perSecond: 1 }, time.now);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);

    // Somebody else's exhausted bucket says nothing about this one.
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("says when to come back, rounded up rather than down", () => {
    // A client that obeys a rounded-down value returns a millisecond early and
    // is refused again, which reads as the limit being broken.
    const time = clock();
    const limiter = createRateLimiter({ burst: 1, perSecond: 0.25 }, time.now);

    limiter.check("a");
    const refused = limiter.check("a");

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(4);

    time.advance(refused.retryAfter);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("never says zero seconds when it is refusing", () => {
    // `Retry-After: 0` tells a client to retry immediately, which is the one
    // instruction a refusal must not give.
    const time = clock();
    const limiter = createRateLimiter({ burst: 1, perSecond: 1000 }, time.now);

    limiter.check("a");
    const refused = limiter.check("a");

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
  });

  describe("what it remembers", () => {
    it("forgets a caller who has been quiet long enough to have refilled", () => {
      // An attacker varying source addresses would otherwise grow this without
      // bound — a guard against enumeration turned into a way to exhaust the
      // process. A refilled bucket is indistinguishable from a caller never
      // seen, so dropping it loses nothing.
      const time = clock();
      const limiter = createRateLimiter({ burst: 2, perSecond: 1 }, time.now);

      limiter.check("quiet");
      expect(limiter.size()).toBe(1);

      time.advance(60);
      limiter.prune(time.now());

      expect(limiter.size()).toBe(0);
    });

    it("keeps a caller who is still spending", () => {
      // The other half, and the mistake the first implementation made in
      // reverse: a sweep that dropped the caller currently making requests
      // would hand them a full bucket on every call, which is no limit at all.
      const time = clock();
      const limiter = createRateLimiter({ burst: 5, perSecond: 1 }, time.now);

      limiter.check("busy");
      limiter.prune(time.now());

      expect(limiter.size()).toBe(1);
    });

    it("releases a flood of distinct callers as they refill", () => {
      const time = clock();
      const limiter = createRateLimiter({ burst: 1, perSecond: 1 }, time.now);

      // Ten thousand addresses, each asking once. What it grows to is the
      // number of distinct callers, not the number of requests — and the
      // threshold prune keeps even that from being the high-water mark
      // forever.
      for (let index = 0; index < 10_000; index += 1) {
        limiter.check(`caller-${index}`);
      }

      expect(limiter.size()).toBeGreaterThan(0);

      time.advance(1);
      limiter.prune(time.now());

      expect(limiter.size()).toBe(0);
    });

    it("prunes itself once it grows past the threshold, without being asked", () => {
      // The lazy sweep, which is what runs in production — nothing calls
      // `prune` there. A test that only exercised the explicit call would pass
      // against an implementation that never triggered it.
      const time = clock();
      const limiter = createRateLimiter({ burst: 1, perSecond: 1 }, time.now);

      for (let index = 0; index < 1_500; index += 1) {
        limiter.check(`caller-${index}`);
      }

      const beforeRefill = limiter.size();

      // Long enough that every one of them has refilled, then one more request
      // to cross the threshold and trigger the sweep.
      time.advance(10);
      limiter.check("anybody");

      expect(beforeRefill).toBeGreaterThan(1_000);
      expect(limiter.size()).toBeLessThan(10);
    });
  });

  describe("who counts as one caller", () => {
    it("treats a mapped IPv4 address and a plain one as the same caller", () => {
      // Measured, not assumed: a dual-stack listener reported
      // `::ffff:127.0.0.1` for a request to `127.0.0.1`. One address, so one
      // bucket — otherwise a listener change silently re-keys every caller.
      expect(bucketKey("::ffff:203.0.113.4")).toBe(bucketKey("203.0.113.4"));
    });

    it("leaves an IPv4 address alone", () => {
      expect(bucketKey("203.0.113.4")).toBe("203.0.113.4");
    });

    it("counts one IPv6 allocation as one caller, not as 2^64 of them", () => {
      // The reason this function exists. An IPv6 client is handed a /64, so a
      // limit keyed on the full address is bypassed by incrementing a number.
      const key = bucketKey("2001:db8:1234:5678:0:0:0:1");

      expect(bucketKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")).toBe(key);
      expect(bucketKey("2001:db8:1234:5678::ffff")).toBe(key);
    });

    it("keeps separate allocations separate", () => {
      // The other half. Collapsing further would put unrelated customers in one
      // bucket, and one attacker would then be able to refuse service to them.
      expect(bucketKey("2001:db8:1234:5678::1")).not.toBe(bucketKey("2001:db8:1234:9999::1"));
    });

    it("reads a compressed address as the address it means", () => {
      // `::1` is `0:0:0:0:0:0:0:1`. Splitting the text on `:` and taking four
      // groups reads it as `["", "", "1"]` and keys loopback on punctuation.
      expect(bucketKey("::1")).toBe(bucketKey("0:0:0:0:0:0:0:1"));
      expect(bucketKey("::1")).not.toBe(bucketKey("2001:db8::1"));
    });

    it("reads one address written two ways as one caller", () => {
      // Leading zeros and case are free choices in IPv6 text, so the same
      // allocation can arrive spelled differently and would otherwise hold two
      // allowances. Node canonicalises today — which is precisely the argument
      // that turned out to be wrong about `::ffff:`.
      expect(bucketKey("2001:0DB8:1234:5678::1")).toBe(bucketKey("2001:db8:1234:5678::1"));
    });

    /**
     * Just enough `Context` for `callerKey`, which reads one variable.
     *
     * A real request cannot answer the question this asks. Under Vitest every
     * request has the same absent address, so an HTTP test cannot show that the
     * address is *not* part of the key when an actor is — only that two actors
     * come out different, which a composite key would also satisfy.
     */
    const contextWith = (principal?: { actorId: number; credentialId: number }) =>
      ({
        get: (name: string) => (name === "principal" ? principal : undefined),
      }) as unknown as Context;

    it("charges an authenticated caller to the actor and to nothing else", () => {
      // The whole key, asserted as an equality rather than as a difference.
      // `toContain("actor:7")` would pass for `actor:7|address:…`, which is the
      // composite key that was rejected — it hands a caller a fresh allowance
      // for every address they appear from.
      expect(callerKey(contextWith({ actorId: 7, credentialId: 3 }))).toBe("actor:7");
    });

    it("falls back to the address, and says which space the key is in", () => {
      // Two spaces, never mixed: actor 1 and a caller at the address "1" are
      // different callers. Without the prefix they would share an allowance.
      const key = callerKey(contextWith());

      expect(key.startsWith("address:")).toBe(true);
      expect(key).not.toBe(callerKey(contextWith({ actorId: 1, credentialId: 1 })));
    });

    it("puts two link-local callers on one interface in one bucket", () => {
      // A zone index rides on the last group, so the /64 truncation discards it
      // and no separate handling is needed. There was some; a mutation showed
      // nothing depended on it, and it went.
      expect(bucketKey("fe80::1%eth0")).toBe(bucketKey("fe80::2%eth0"));
    });
  });

  it("makes a sweep of ten thousand serials take hours rather than seconds", () => {
    // The point of the whole thing, stated as the number it produces. #120 is
    // explicit that the yes-or-no cannot be removed from an unauthenticated
    // write endpoint — so what changes is the price.
    //
    // **The shipping constant, not a copy of it.** Written with `{ burst: 20,
    // perSecond: 0.2 }` inline this passed against an `app.ts` whose limit had
    // been raised to a million — measured, not feared. A test that restates the
    // numbers it is checking proves the arithmetic and nothing about the
    // product.
    const time = clock();
    const limiter = createRateLimiter(WRITE_RATE_LIMIT, time.now);

    let allowed = 0;
    let seconds = 0;

    // An attacker asking as fast as the limiter will let them, for an hour.
    while (seconds < 3600) {
      if (limiter.check("attacker").allowed) allowed += 1;
      time.advance(1);
      seconds += 1;
    }

    // 20 burst plus 0.2/second for an hour.
    expect(allowed).toBeLessThan(760);
    expect(10_000 / allowed).toBeGreaterThan(13);
  });
});
