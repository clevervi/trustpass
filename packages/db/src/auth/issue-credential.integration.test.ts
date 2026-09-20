import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { digestOf, digestsMatch, parseToken } from "./credential-token.js";
import { IssuanceFailed, issueCredentialFor } from "./issue-credential.js";
import { verifyCredential } from "./verify-credential.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Issuing a credential, against a real database.
 *
 * The distinction this file exists to hold: **a row in `credential` is not a
 * credential.** A row whose digest nobody can produce a matching secret for is
 * indistinguishable from a correct one until somebody tries to use it, so every
 * success here ends by presenting the token to the verifier rather than by
 * asserting that an insert happened.
 */
describe.skipIf(!databaseUrl)("issuing a credential", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let raw: postgres.Sql;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
    raw = postgres(databaseUrl as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await raw.end();
    await db.$client.end();
  });

  function request(label: string) {
    return {
      label,
      actor: { create: { kind: "service" as const, displayName: `${run} ${label}` } },
    };
  }

  it("creates the actor it was told to create, and a credential for it", async () => {
    const issued = await issueCredentialFor(raw, request("creates one"), "dev");

    expect(issued.actorWasCreated).toBe(true);
    expect(issued.actorId).toBeGreaterThan(0);
    expect(issued.credentialId).toBeGreaterThan(0);
  });

  it("issues a token the verifier accepts, which is the only proof that matters", async () => {
    // The assertion that cannot pass by accident. An insert that stored a
    // digest of something other than the secret it printed would satisfy every
    // other test in this file.
    const issued = await issueCredentialFor(raw, request("really works"), "dev");
    const principal = await verifyCredential(db, issued.token, "dev");

    expect(principal).toEqual({ actorId: issued.actorId, credentialId: issued.credentialId });
  });

  it("stores a digest of the secret it printed, and not the secret", async () => {
    const issued = await issueCredentialFor(raw, request("digest only"), "dev");
    const parsed = parseToken(issued.token, "dev");

    const [row] = await raw<{ handle: string; secret_digest: Buffer }[]>`
      SELECT handle, secret_digest FROM credential WHERE id = ${issued.credentialId}
    `;

    expect(row?.handle).toBe(parsed?.handle);
    expect(digestsMatch(digestOf(parsed?.secret as string), row?.secret_digest as Buffer)).toBe(
      true,
    );
    expect(row?.secret_digest.toString("hex")).not.toContain(parsed?.secret);
  });

  it("uses an actor that already exists rather than making a second one", async () => {
    const first = await issueCredentialFor(raw, request("first key"), "dev");
    const second = await issueCredentialFor(
      raw,
      { label: "second key", actor: { existing: first.actorId } },
      "dev",
    );

    expect(second.actorWasCreated).toBe(false);
    expect(second.actorId).toBe(first.actorId);
    expect(second.credentialId).not.toBe(first.credentialId);

    // Two credentials, one actor — which is what `label` exists for, and what
    // makes rotation possible without a new identity.
    expect(await verifyCredential(db, first.token, "dev")).toMatchObject({
      actorId: first.actorId,
    });
    expect(await verifyCredential(db, second.token, "dev")).toMatchObject({
      actorId: first.actorId,
    });
  });

  it("refuses an actor that does not exist, and writes nothing", async () => {
    // Both halves. A refusal that still left a credential row would be worse
    // than no refusal: an orphan with a digest nobody holds the secret for.
    //
    // Counted by label rather than over the table. The first version read
    // `count(*) FROM credential` before and after, and failed roughly one run
    // in three: vitest runs test files in parallel and three of them issue
    // credentials, so the count moved because another file wrote, not because
    // this refusal did. It measured the database instead of the operation, and
    // the failure it produced accused the wrong code.
    //
    // By label and not by `actor_id`, which would have been the easy scope and
    // a tautology: `credential.actor_id` references `actor`, so a row naming an
    // actor that does not exist is one the foreign key already makes
    // impossible. The label catches a credential written under *any* actor,
    // including one this call invented on the way — which is the orphan the
    // test is named for.
    const label = "never issued";
    const missing = 2_000_000_000;

    await expect(
      issueCredentialFor(raw, { label, actor: { existing: missing } }, "dev"),
    ).rejects.toThrow(IssuanceFailed);

    const [{ written }] = (await raw`
      SELECT count(*)::int AS written FROM credential WHERE label = ${label}
    `) as unknown as [{ written: number }];

    expect(written).toBe(0);
  });

  it("refuses with a reason, not merely by throwing", async () => {
    try {
      await issueCredentialFor(
        raw,
        { label: "no actor", actor: { existing: 2_000_000_001 } },
        "dev",
      );
      expect.fail("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(IssuanceFailed);
      expect((error as IssuanceFailed).reason).toBe("no_such_actor");
    }
  });

  it("creates no membership and no capacity grant", async () => {
    // **The boundary #152 depends on.** A credential authenticates and grants
    // nothing — ADR 0011 §5. If issuance created either of these, every
    // credential would arrive with authority attached and nothing today would
    // notice, because the authority model has no consumers yet.
    const issued = await issueCredentialFor(raw, request("grants nothing"), "dev");

    const [counts] = (await raw`
      SELECT
        (SELECT count(*)::int FROM membership     WHERE actor_id = ${issued.actorId}) AS memberships,
        (SELECT count(*)::int FROM capacity_grant WHERE actor_id = ${issued.actorId}) AS grants
    `) as unknown as [{ memberships: number; grants: number }];

    expect(counts.memberships).toBe(0);
    expect(counts.grants).toBe(0);
  });

  it("binds the token to the environment it was issued for", async () => {
    const issued = await issueCredentialFor(raw, request("staging only"), "staging");

    expect(await verifyCredential(db, issued.token, "staging")).not.toBeNull();
    expect(await verifyCredential(db, issued.token, "dev")).toBeNull();
    expect(await verifyCredential(db, issued.token, "live")).toBeNull();
  });

  it("gives every credential its own handle", async () => {
    const issued = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        issueCredentialFor(raw, request(`bulk ${index}`), "dev"),
      ),
    );

    const handles = new Set(issued.map((one) => parseToken(one.token, "dev")?.handle));

    expect(handles.size).toBe(issued.length);
  });

  it("leaves the issued credential active, with no expiry and no revocation", async () => {
    const issued = await issueCredentialFor(raw, request("fresh"), "dev");

    const [row] = (await db.execute(sql`
      SELECT expires_at, revoked_at, kind FROM credential WHERE id = ${issued.credentialId}
    `)) as unknown as { expires_at: Date | null; revoked_at: Date | null; kind: string }[];

    // No expiry by default is a decision: ADR 0014 §2 says null means no fixed
    // expiry and rotation is still expected. A default lifetime invented here
    // would be a policy nobody chose.
    expect(row?.expires_at).toBeNull();
    expect(row?.revoked_at).toBeNull();
    expect(row?.kind).toBe("api_key");
  });
});
