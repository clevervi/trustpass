/**
 * Lets the attacks win, and checks that nothing survived them.
 *
 * `least-privilege.integration.test.ts` runs its attacks through a transaction
 * that can only end in a rollback, and every one of them is refused by the
 * privilege model before it touches anything. So the suite being green says the
 * privileges are right. **It says nothing about the rollback**, because the
 * rollback has never had anything to undo.
 *
 * That is the claim #170 made and could not leave behind: nine attacks can
 * succeed and the database stays byte-identical. Its evidence was a shell script
 * in a temporary directory, described in a pull request and now gone — which is
 * #172, and this is that script where it can be run again.
 *
 * **How the attacks are made to win.** Not by breaking the privilege model: that
 * means a real `GRANT` on a real cluster, and the window where it is in force is
 * a window where the model is off. They run on `DATABASE_URL` instead — the
 * owning connection, which is not refused anything. The property under test is
 * *what happens after a statement succeeds*, and that is the same property
 * whichever way it came to succeed.
 *
 * **The control is the row that matters.** A fingerprint that cannot see residue
 * would report no difference for a harness that does nothing, so the last attack
 * is also run without a transaction and the fingerprint is required to move.
 * Without it this script proves that a measurement returns the same value twice.
 *
 * ```bash
 * TP_ATTACK_RESIDUE=i-understand \
 *   DATABASE_URL=postgres://... pnpm exec tsx src/scripts/attack-residue.ts
 * ```
 *
 * It refuses to start without that variable. The control deliberately commits a
 * schema change and then reverses it, so this must not be pointed at anything
 * whose state matters — and "the developer database" is such a thing.
 */
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../client.js";
import {
  type Fingerprint,
  fingerprintDifferences,
  schemaFingerprint,
} from "../testing/schema-fingerprint.js";

/**
 * Statements that change the shape of the database rather than its contents.
 *
 * Drawn from the attack table in `least-privilege.integration.test.ts`: the
 * objects each one touches — a trigger's enabled state, a column's default, a
 * privilege, a constraint — are the ones the fingerprint's sections exist to
 * watch. Contents are not interesting here; a rollback undoing an INSERT is not
 * in doubt.
 */
const ATTACKS: readonly string[] = [
  "ALTER TABLE product DISABLE TRIGGER ALL",
  "GRANT UPDATE (serial) ON product TO trustpass_runtime",
  "GRANT DELETE ON lifecycle_event TO trustpass_runtime",
  "ALTER TABLE lifecycle_event ADD COLUMN tp_probe text",
  "ALTER TABLE product ALTER COLUMN status SET DEFAULT 'retired'",
  // No `IF EXISTS`, and the trigger's real name. The first version had both
  // wrong and Postgres said so in a NOTICE — `trigger ... does not exist,
  // skipping` — while the row still printed `succeeded` and the fingerprint
  // still showed no difference. An attack that changes nothing leaves no residue
  // whatever the rollback does, so it reads as evidence and is not.
  //
  // Without `IF EXISTS` a wrong name raises, the row reads `refused`, and the
  // count below stops the run. The guard that catches this was already here; the
  // statement was written in the one form that could slip past it.
  "DROP TRIGGER product_provenance_on_insert ON product",
];

/** The sentinel that unwinds a transaction whose statement was not refused. */
class AttackSucceeded extends Error {
  constructor(statement: string) {
    super(statement);
    this.name = "AttackSucceeded";
  }
}

/**
 * Runs one statement and rolls it back, reporting whether it was refused.
 *
 * The throw is unconditional and carries the statement out. A rollback that
 * depends on an assertion failing is the mistake this repository has already
 * made once: under mutation the assertion passed, nothing rolled back, and a
 * column was left altered in a live database.
 */
async function attemptAndRollBack(
  db: Database,
  statement: string,
): Promise<"succeeded" | "refused"> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(statement));

      throw new AttackSucceeded(statement);
    });
  } catch (error) {
    return error instanceof AttackSucceeded ? "succeeded" : "refused";
  }

  throw new Error(`The transaction returned without refusing or rolling back: ${statement}`);
}

function report(title: string, differences: readonly string[]): void {
  console.log(`\n${title}`);

  if (differences.length === 0) {
    console.log("  no difference");
    return;
  }

  for (const difference of differences.slice(0, 12)) console.log(`  ${difference}`);
  if (differences.length > 12) console.log(`  …and ${differences.length - 12} more`);
}

async function main(): Promise<void> {
  if (process.env.TP_ATTACK_RESIDUE !== "i-understand") {
    console.error("Refusing: this commits a schema change and reverses it, as its own control.");
    console.error("Point it at a throwaway cluster and set TP_ATTACK_RESIDUE=i-understand.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error("Refusing: DATABASE_URL is not set, and this cannot guess one.");
    process.exitCode = 1;
    return;
  }

  const db = createDatabase(url);

  try {
    // Taken first, and taken through the same function the comparison uses. A
    // fingerprint gathered a different way would be comparing two measurements
    // rather than two states.
    const before: Fingerprint = await schemaFingerprint(db);

    console.log(`Fingerprint taken. ${Object.keys(before).length} sections, all present.`);
    console.log(`Running ${ATTACKS.length} attacks on the owning connection.\n`);

    let succeeded = 0;

    for (const attack of ATTACKS) {
      const outcome = await attemptAndRollBack(db, attack);

      if (outcome === "succeeded") succeeded += 1;
      console.log(`  ${outcome.padEnd(9)}  ${attack}`);
    }

    // A run where everything was refused proves nothing about a rollback, and
    // would otherwise print the same reassuring "no difference" as a run where
    // everything succeeded and was undone. Those are opposite results.
    if (succeeded !== ATTACKS.length) {
      console.error(`\nOnly ${succeeded} of ${ATTACKS.length} attacks succeeded.`);
      console.error("This connection is not the owning one, so the rollback was never asked to");
      console.error("undo anything and the comparison below would be about nothing.");
      process.exitCode = 1;
      return;
    }

    report(
      "After all of them succeeded and were rolled back:",
      fingerprintDifferences(before, await schemaFingerprint(db)),
    );

    // The control. Same statement, no transaction.
    console.log("\nControl: the same change, committed, so the fingerprint has to move.");

    await db.execute(sql`ALTER TABLE lifecycle_event ADD COLUMN tp_residue_probe text`);

    const moved = fingerprintDifferences(before, await schemaFingerprint(db));

    report("After one committed change:", moved);

    await db.execute(sql`ALTER TABLE lifecycle_event DROP COLUMN tp_residue_probe`);

    const restored = fingerprintDifferences(before, await schemaFingerprint(db));

    report("After reversing it:", restored);

    if (moved.length === 0) {
      console.error("\nThe control did not move the fingerprint, so it cannot see residue at all.");
      console.error("Every 'no difference' above is therefore worth nothing.");
      process.exitCode = 1;
      return;
    }

    if (restored.length > 0) {
      console.error("\nThis script left the database changed. That is its own defect.");
      process.exitCode = 1;
      return;
    }

    // Scoped deliberately. An earlier version ended on "every attack succeeded,
    // every rollback held", which reads as a result about the privilege model
    // and is not one: these ran as the owner, and the runtime never gets far
    // enough to need cleaning up after. What was measured is the harness.
    console.log("\nEvery statement that succeeded was undone, and the control proves the");
    console.log("comparison can see residue when there is some.");
    console.log("");
    console.log("That is a result about the rollback, not about the privilege model. These");
    console.log("ran on the owning connection; trustpass_runtime is refused before it");
    console.log("touches anything, which is least-privilege.integration.test.ts's 59 cases");
    console.log("and not this script's.");
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1]?.endsWith("attack-residue.ts")) {
  await main();
}
