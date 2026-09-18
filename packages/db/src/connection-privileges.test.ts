import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  type ConnectionPrivileges,
  privilegeFailures,
  readConnectionPrivileges,
} from "./connection-privileges.js";

/**
 * A connection that can do none of it. Every case below starts here and moves
 * exactly one thing, so a failure names the condition rather than the fixture.
 */
const UNPRIVILEGED: ConnectionPrivileges = {
  role: "trustpass_runtime",
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRowLevelSecurity: false,
  reachableOwnership: 0,
};

describe("privilegeFailures", () => {
  it("passes a connection that owns nothing and carries no attribute", () => {
    expect(privilegeFailures(UNPRIVILEGED)).toEqual([]);
  });

  it.each([
    ["superuser", { superuser: true }, /superuser/i],
    ["replication", { replication: true }, /replicate/i],
    ["bypassrls", { bypassRowLevelSecurity: true }, /row-level security/i],
    ["createrole", { createRole: true }, /create roles/i],
    ["createdb", { createDatabase: true }, /create databases/i],
  ] as const)("refuses a connection that has %s", (_name, change, expected) => {
    const failures = privilegeFailures({ ...UNPRIVILEGED, ...change });

    // One failure, not "at least one": a fixture that moves a single field and
    // produces two reasons means a condition is reading the wrong one.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(expected);
  });

  it("refuses a connection that can become an owner even with every attribute clear", () => {
    // The case a check built from the five attributes alone waves through, and
    // the reason this field exists. Measured against the live database:
    //
    //   role                 five flags clear   owns directly   can become owner
    //   trustpass_migration  YES                0               16
    //   trustpass_runtime    yes                0               0
    //
    // `trustpass_migration` carries nothing and owns nothing, and one
    // `SET ROLE trustpass_owner` makes it the owner of every table — which is
    // enough to disable the trigger protecting the history.
    const failures = privilegeFailures({
      ...UNPRIVILEGED,
      role: "trustpass_migration",
      reachableOwnership: 16,
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/become the owner of 16 object\(s\)/);
  });

  it("reports every reason at once rather than stopping at the first", () => {
    // A deploy pointed at the wrong role should learn everything wrong with it
    // in one go. Returning after the first would mean fixing one attribute,
    // redeploying, and meeting the next.
    const failures = privilegeFailures({
      role: "trustpass",
      superuser: true,
      createDatabase: true,
      createRole: true,
      replication: true,
      bypassRowLevelSecurity: true,
      reachableOwnership: 16,
    });

    expect(failures).toHaveLength(6);
  });
  it("leads with the attribute that makes the rest irrelevant", () => {
    // A superuser passes every privilege check ever written, so it is the first
    // thing a reader needs to see. Ordering is a deliberate property here, not
    // an accident of how the ifs were typed.
    const failures = privilegeFailures({
      ...UNPRIVILEGED,
      superuser: true,
      createDatabase: true,
      reachableOwnership: 16,
    });

    expect(failures[0]).toMatch(/superuser/i);
  });
});

describe("readConnectionPrivileges", () => {
  it("refuses to treat an unanswered question as a clean answer", async () => {
    // Added because the mutation check caught this branch having no test at
    // all: replacing the throw with a permissive "everything false" left all
    // sixteen tests green. The one branch whose whole job is to fail closed was
    // the one branch nothing could prove.
    //
    // A stub rather than a real connection, because no query against a working
    // Postgres produces an empty result here — the row is a row about the role
    // doing the asking. The branch exists for the shapes that are not a working
    // Postgres: a pooler answering for something else, a proxy returning an
    // empty set, a driver change.
    const silent = { execute: async () => [] } as unknown as Database;

    await expect(readConnectionPrivileges(silent)).rejects.toThrow(/Refusing to continue/);
  });
});
