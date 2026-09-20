import { createInterface } from "node:readline/promises";
import { createDatabase, parseToken, schema, verifyCredential } from "@trustpass/db";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import { enrolProduct } from "../enrolments/enrol-product.js";
import { loadEnv } from "../env.js";

/**
 * Proves a credential works, end to end, without printing it.
 *
 * `db:issue-credential` prints a token and stops there. Whether that token is
 * usable is a different question, and answering it by hand means writing `curl`
 * with the secret on a command line — where it lands in shell history and in
 * the process table, which is the same class of leak the issuing command's TTY
 * barrier exists to prevent.
 *
 * So: the token is read from stdin, used once, and never echoed or stored. What
 * this prints is the evidence and nothing else — the actor the verifier
 * resolved, the status the endpoint returned, and the `actor_id` on the record
 * that resulted.
 *
 * It closes the one criterion of #151 that no automated test can: the issuing
 * command needs an interactive terminal, so the loop from a real terminal to a
 * real row has to be run by a person. This is the second half of that run.
 *
 * **It writes an enrolment.** That is not a side effect to apologise for — it
 * is the proof. A verification that only asked the verifier would show the
 * credential parses, not that a write attributed to it lands correctly.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = (
    await rl.question("Paste the token. It is used once and never stored or echoed: ")
  ).trim();
  rl.close();

  try {
    if (parseToken(token, env.TRUSTPASS_ENV) === null) {
      // Said before any lookup, because "that is not a token for this
      // environment" is a statement about the shape of what was pasted and
      // costs the database nothing.
      console.error(
        `That is not a token this build accepts for TRUSTPASS_ENV=${env.TRUSTPASS_ENV}.`,
      );
      process.exit(1);
    }

    const principal = await verifyCredential(db, token, env.TRUSTPASS_ENV);

    if (principal === null) {
      console.error("The verifier refused it.");
      console.error("Absent, unknown, expired, revoked or the wrong environment — it does not say");
      console.error("which, deliberately, and neither does this.");
      process.exit(1);
    }

    console.log(
      `verifier          actor ${principal.actorId}, credential ${principal.credentialId}`,
    );

    const app = createApp({
      version: "verify",
      checkDatabase: async () => true,
      authenticate: (presented) => verifyCredential(db, presented, env.TRUSTPASS_ENV),
      enrolProduct: (input, who) => enrolProduct(db, input, who),
      registerProduct: async () => {
        throw new Error("This check does not register products.");
      },
      readPassport: async () => {
        throw new Error("This check does not read passports.");
      },
    });

    const serial = `TP177-PROOF-${Date.now()}`;

    const response = await app.request("/enrolments", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ brand: "ASUS", model: "ROG", serial, category: "gpu" }),
    });

    console.log(`POST /enrolments  ${response.status}`);

    const [product] = await db
      .select()
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    const [event] = await db
      .select()
      .from(schema.lifecycleEvent)
      .where(eq(schema.lifecycleEvent.productId, product?.id ?? -1));

    console.log(`serial            ${serial}`);
    console.log(`trustpass id      ${product?.trustpassId ?? "(no product)"}`);
    console.log(`event actor_id    ${event?.actorId ?? "(none)"}`);
    console.log(`event actor_kind  ${event?.actorKind ?? "(none)"}`);
    console.log("");

    const attributed = event?.actorId === principal.actorId;
    const created = response.status === 201;

    if (created && attributed) {
      console.log("PASS");
      console.log("The record names the actor this credential resolved to. That is the loop:");
      console.log("a terminal printed a secret, the secret authenticated over HTTP, and the row");
      console.log("it produced is attributed to the right actor.");
      return;
    }

    console.error("FAIL");
    if (!created) {
      console.error(`  the endpoint returned ${response.status}, not 201`);
    }
    if (!attributed) {
      console.error(`  the record names ${event?.actorId ?? "nobody"}, not ${principal.actorId}`);
    }
    process.exit(1);
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
