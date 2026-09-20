import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { EnrolProductResult } from "../enrolments/enrol-product.js";
import {
  authenticates,
  buildDependencies,
  credentialHeaders,
  NO_RATE_LIMIT,
} from "../testing/dependencies.js";

/**
 * What a stranger holding a serial can find out.
 *
 * `/enrolments` had no route test at all, which is part of how the disclosure
 * lasted: the conflict response named the TrustPass ID of the existing
 * enrolment, and the only thing describing that was the OpenAPI text saying it
 * was a feature.
 *
 * A serial is printed on the outside of the object. ADR 0004 spends its whole
 * Context on the identifier not being enumerable; returning it in exchange for
 * a serial makes a photograph of a label into a passport lookup.
 *
 * **What these tests do not claim.** The existence signal is still there, and
 * it is inherent rather than overlooked: `product_live_holder_serial_idx` makes
 * a second live enrolment impossible, and an endpoint that accepts writes has
 * to tell an honest caller whether the write happened. "It did not, because
 * that serial is taken" *is* the leak. It closes when enrolment stops being
 * unauthenticated, which is #141. Until then the tests below say precisely
 * which half an attacker still has.
 */

const BODY = {
  brand: "ASUS",
  model: "ROG Strix RTX 5070 Ti",
  serial: "M1LMCS004896",
  category: "gpu",
};

const EXISTING_ID = "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB";

// Named separately so the sweep can vary the serial. Reaching into ENROLLED
// for it does not typecheck: the result is a union, and `.product` only exists
// on one side of it.
const PRODUCT = {
  trustpassId: EXISTING_ID,
  brand: BODY.brand,
  model: BODY.model,
  serial: BODY.serial,
  category: "gpu",
  status: "registered",
  origin: "holder",
  createdAt: new Date("2026-09-18T12:00:00.000Z"),
} as const;

const ENROLLED: EnrolProductResult = { ok: true, product: PRODUCT };

const TAKEN: EnrolProductResult = { ok: false, reason: "duplicate_serial" };

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/enrolments", {
    method: "POST",
    headers: { "content-type": "application/json", ...credentialHeaders() },
    body: JSON.stringify(body),
  });
}

describe("POST /enrolments", () => {
  it("hands the service four fields, whatever the body contained", async () => {
    // The layer, on its own. Three things stop a body's identity reaching a
    // row — the schema stripping unknown keys, the service naming its fields,
    // and the repository writing literals — and each is sufficient by itself,
    // so no end-to-end test can go red when one of them is removed. Measured:
    // making this schema `.passthrough()` left every integration test green.
    //
    // This one covers the first layer and nothing else.
    let received: unknown;

    const app = createApp(
      buildDependencies({
        authenticate: authenticates(),
        enrolProduct: async (input) => {
          received = input;
          return ENROLLED;
        },
      }),
    );

    await post(app, {
      ...BODY,
      actorId: 999,
      actorKind: "issuer",
      actor_kind: "issuer",
      credentialId: 999,
      organizationId: 999,
      issuer: { country: "CO", registrationNumber: "999" },
      origin: "supply_chain",
      status: "verified",
      trustpassId: "TP1-ATTACKER-CHOSE-THIS",
    });

    expect(Object.keys(received as object).sort()).toEqual([
      "brand",
      "category",
      "model",
      "serial",
    ]);
  });

  it("returns 201 and the identifier to the caller that created it", async () => {
    const app = createApp(
      buildDependencies({ authenticate: authenticates(), enrolProduct: async () => ENROLLED }),
    );
    const response = await post(app, BODY);

    expect(response.status).toBe(201);
    expect(((await response.json()) as { trustpassId: string }).trustpassId).toBe(EXISTING_ID);
  });

  it("names no identifier when the serial is taken", async () => {
    // The disclosure. It was deliberate — a client that timed out and retried
    // learned what it had already created — and it was the wrong trade.
    const app = createApp(
      buildDependencies({ authenticate: authenticates(), enrolProduct: async () => TAKEN }),
    );
    const response = await post(app, BODY);

    expect(response.status).toBe(409);

    const raw = await response.text();

    expect(raw).not.toContain(EXISTING_ID);
    expect(raw).not.toMatch(/TP\d-/);
  });

  it("does not echo the serial back", async () => {
    // Smaller than the identifier and the same kind of thing: a response that
    // repeats the serial confirms which one was asked about, and a sweep sees
    // little else.
    const app = createApp(
      buildDependencies({ authenticate: authenticates(), enrolProduct: async () => TAKEN }),
    );
    const raw = await (await post(app, BODY)).text();

    expect(raw).not.toContain(BODY.serial);
  });
});

describe("what a sweep over a serial range learns", () => {
  /**
   * Walks a range against a stub that knows which serials are taken, and
   * compares everything a caller can see.
   */
  async function sweep(taken: ReadonlySet<string>) {
    const app = createApp(
      buildDependencies({
        authenticate: authenticates(),
        enrolProduct: async (input): Promise<EnrolProductResult> =>
          taken.has(input.serial)
            ? TAKEN
            : { ok: true, product: { ...PRODUCT, serial: input.serial } },
      }),
      { kind: "none" },
      // The default burst is 20 and this walks 20 serials, so it fit by
      // arithmetic rather than by intent — one more serial and the test would
      // have been measuring the rate limiter while claiming to measure
      // disclosure. What the limiter does has its own tests.
      NO_RATE_LIMIT,
    );

    const observations = [];

    for (let index = 0; index < 20; index += 1) {
      const serial = `SWEEP-${String(index).padStart(4, "0")}`;
      const response = await post(app, { ...BODY, serial });

      observations.push({
        serial,
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()]
          // `x-request-id` is a per-request correlation id and is meant to
          // differ; it says nothing about the serial. `date` and
          // `content-length` likewise. Everything else must match, and the
          // first run of this test proved these three were the only things
          // that did not.
          .filter(([name]) => !["date", "content-length", "x-request-id"].includes(name))
          .map(([name, value]) => `${name}:${value}`)
          .sort(),
      });
    }

    return observations;
  }

  it("learns no identifier, for any serial in the range", async () => {
    const observations = await sweep(new Set(["SWEEP-0003", "SWEEP-0011", "SWEEP-0017"]));
    const conflicts = observations.filter((o) => o.status === 409);

    expect(conflicts).toHaveLength(3);

    for (const conflict of conflicts) {
      expect(conflict.body).not.toMatch(/TP\d-/);
      expect(conflict.body).not.toContain(conflict.serial);
    }
  });

  it("gets one identical conflict response for every taken serial", async () => {
    // If two conflicts differed at all, the difference would be about the
    // serial — which is the thing being kept back.
    const observations = await sweep(new Set(["SWEEP-0003", "SWEEP-0011", "SWEEP-0017"]));
    const conflicts = observations.filter((o) => o.status === 409);
    const distinct = new Set(conflicts.map((c) => `${c.status}|${c.body}|${c.headers.join(",")}`));

    expect(distinct.size).toBe(1);
  });

  it("still tells a sweep which serials are taken, and this test says so", async () => {
    // Asserting the hole rather than pretending it is closed.
    //
    // 201 and 409 are different, and they have to be: a write endpoint that
    // will not say whether the write happened is unusable, and one that lies
    // about it is worse. What an attacker gets from this endpoint today is a
    // yes-or-no per serial, at one request each, and nothing that identifies
    // the record behind a yes.
    //
    // The yes-or-no closes under #141, when enrolling requires being somebody.
    // Rate limiting narrows it before then — #120 keeps that criterion open.
    // This test exists so that neither is mistaken for done.
    const taken = new Set(["SWEEP-0003", "SWEEP-0011", "SWEEP-0017"]);
    const observations = await sweep(taken);

    const inferred = new Set(observations.filter((o) => o.status === 409).map((o) => o.serial));

    expect(inferred).toEqual(taken);
  });
});
