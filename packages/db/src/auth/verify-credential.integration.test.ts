import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { actor } from "../schema/actor.js";
import { credential } from "../schema/credential.js";
import { issueToken } from "./credential-token.js";
import { verifyCredential } from "./verify-credential.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The cases from ADR 0014 §9, against a real database.
 *
 * They are written before the verifier and each must fail for its own reason.
 * The one that is easy to skip is the second: a test where a single credential
 * exists passes whether the verifier resolved that credential or returned the
 * first row it found, and proves nothing about which.
 */
describe.skipIf(!databaseUrl)("a credential resolves to an actor, or to nothing", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let n = 0;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM credential WHERE label LIKE ${`${run}%`}`);
    await db.execute(sql`DELETE FROM actor WHERE display_name LIKE ${`${run}%`}`);
    await db.$client.end();
  });

  async function newActor(): Promise<number> {
    n += 1;
    const [created] = await db
      .insert(actor)
      .values({ kind: "service", displayName: `${run} actor ${n}` })
      .returning({ id: actor.id });

    return created?.id as number;
  }

  /** Issues one for real: the same function the operator command will call. */
  async function issue(
    options: { expiresAt?: Date | null; revokedAt?: Date | null } = {},
  ): Promise<{ token: string; actorId: number; credentialId: number }> {
    const actorId = await newActor();
    const minted = issueToken("live");

    const [created] = await db
      .insert(credential)
      .values({
        actorId,
        kind: "api_key",
        label: `${run} credential ${n}`,
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: options.expiresAt ?? null,
        revokedAt: options.revokedAt ?? null,
        handle: minted.handle,
        secretDigest: minted.digest,
      })
      .returning({ id: credential.id });

    return { token: minted.token, actorId, credentialId: created?.id as number };
  }

  it("resolves an active credential to its own actor", async () => {
    const { token, actorId, credentialId } = await issue();

    expect(await verifyCredential(db, token, "live")).toEqual({ actorId, credentialId });
  });

  it("resolves each credential to its own actor and not to any other", async () => {
    // A verifier that returned the first row of the table would pass a
    // single-credential test and fail here.
    const first = await issue();
    const second = await issue();

    expect(await verifyCredential(db, first.token, "live")).toEqual({
      actorId: first.actorId,
      credentialId: first.credentialId,
    });
    expect(await verifyCredential(db, second.token, "live")).toEqual({
      actorId: second.actorId,
      credentialId: second.credentialId,
    });
    expect(first.actorId).not.toBe(second.actorId);
  });

  it("refuses a revoked credential", async () => {
    const { token } = await issue({ revokedAt: new Date(Date.now() - 1_000) });

    expect(await verifyCredential(db, token, "live")).toBeNull();
  });

  it("refuses a credential that has already expired", async () => {
    const { token } = await issue({ expiresAt: new Date(Date.now() - 1_000) });

    expect(await verifyCredential(db, token, "live")).toBeNull();
  });

  it("accepts a credential that expires later", async () => {
    const { token, actorId } = await issue({ expiresAt: new Date(Date.now() + 3_600_000) });

    expect(await verifyCredential(db, token, "live")).toMatchObject({ actorId });
  });

  it("treats a credential expiring exactly at now() as expired", async () => {
    // ADR 0014 §2 pins this to `>` rather than `>=` — one character in one
    // query, and exactly where an edge-case bug lives.
    //
    // Inside a transaction `now()` is the transaction's start time and does not
    // move, so a row written with `expires_at = now()` is still exactly equal to
    // the `now()` the verifying query sees. Outside one the clock advances
    // between the two statements and the row is expired under either operator —
    // which is the trap: it would look like a boundary test and be a tautology.
    await db.transaction(async (tx) => {
      const actorId = await newActor();
      const minted = issueToken("live");

      await tx.execute(sql`
        INSERT INTO credential (actor_id, kind, label, issued_at, expires_at, handle, secret_digest)
        VALUES (${actorId}, 'api_key', ${`${run} boundary`}, now() - interval '1 hour', now(),
                ${minted.handle}, ${minted.digest})
      `);

      expect(await verifyCredential(tx, minted.token, "live")).toBeNull();
    });
  });

  it("refuses a well-formed token whose handle belongs to nothing", async () => {
    expect(await verifyCredential(db, issueToken("live").token, "live")).toBeNull();
  });

  it("refuses the right handle with the wrong secret", async () => {
    const { token } = await issue();
    const [prefix, environment, handle] = token.split(".");
    const forged = [prefix, environment, handle, issueToken("live").token.split(".")[3]].join(".");

    expect(await verifyCredential(db, forged, "live")).toBeNull();
  });

  it("refuses a credential whose secret was never stored", async () => {
    // The rows that predate this feature. They are legal and must stay
    // unreachable: a null digest must never compare equal to anything.
    const actorId = await newActor();
    const minted = issueToken("live");

    await db.execute(sql`
      INSERT INTO credential (actor_id, kind, label, issued_at)
      VALUES (${actorId}, 'api_key', ${`${run} legacy`}, now() - interval '1 hour')
    `);

    expect(await verifyCredential(db, minted.token, "live")).toBeNull();
  });

  /**
   * A database that records being touched and refuses to be useful.
   *
   * Counting rather than only throwing, because "it did not throw" and "it
   * issued no query" are different statements and only the second is the claim.
   */
  function databaseThatCounts() {
    let reached = 0;

    const counting = new Proxy(
      {},
      {
        get(_target, property) {
          reached += 1;
          throw new Error(`the verifier reached the database: .${String(property)}()`);
        },
      },
    ) as unknown as Database;

    return { counting, reached: () => reached };
  }

  it("issues no query for anything it can refuse without one", async () => {
    // A credential that cannot be valid here must cost nothing: no round trip,
    // and no question asked of the database that a timing difference could
    // answer. Proved structurally rather than by reading the code.
    const { token } = await issue();
    const [, , handle, secret] = token.split(".");

    const refusedWithoutAsking: readonly (readonly [string, string | undefined])[] = [
      ["nothing presented", undefined],
      ["an empty string", ""],
      ["no structure at all", "nonsense"],
      ["a staging token against live", `tp.staging.${handle}.${secret}`],
      ["a dev token against live", `tp.dev.${handle}.${secret}`],
      ["the wrong prefix", `xx.live.${handle}.${secret}`],
      ["a truncated handle", `tp.live.${handle?.slice(0, 10)}.${secret}`],
      ["a truncated secret", `tp.live.${handle}.${secret?.slice(0, 42)}`],
      ["a handle outside the alphabet", `tp.live.${"+".repeat(11)}.${secret}`],
      ["an extra segment", `${token}.extra`],
    ];

    for (const [label, presented] of refusedWithoutAsking) {
      const { counting, reached } = databaseThatCounts();

      expect(await verifyCredential(counting, presented, "live"), label).toBeNull();
      expect(reached(), label).toBe(0);
    }
  });

  it("does reach the database for a token it cannot refuse on shape alone", async () => {
    // The instrument's own test. Without it, "zero queries" above is equally
    // true of a counter that never counts, and the suite would prove nothing
    // while looking thorough.
    const { counting, reached } = databaseThatCounts();
    const { token } = await issue();

    await expect(verifyCredential(counting, token, "live")).rejects.toThrow(/reached the database/);
    expect(reached()).toBe(1);
  });

  it("puts the presented secret in nothing it writes", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    try {
      const { token } = await issue();
      const secret = token.split(".")[3] as string;

      await verifyCredential(db, token, "live");
      await verifyCredential(db, `${token}x`, "live");
      await verifyCredential(db, issueToken("live").token, "live");

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(secret);
        }
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
