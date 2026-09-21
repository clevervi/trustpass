/**
 * The half of the fingerprint that decides, separated from the half that asks
 * Postgres.
 *
 * The split is not stylistic. The `Mutations` workflow has no Postgres service,
 * so a guard reachable only through an integration test cannot be mutation
 * checked — the name filter matches a skipped test and the runner reports
 * `no-such-test` instead of a verdict. A refusal nothing can break on purpose is
 * a refusal nobody has shown to work.
 */
import { describe, expect, it } from "vitest";
import { type Fingerprint, fingerprintDifferences, missingSections } from "./schema-fingerprint.js";

/**
 * Every section, written out rather than derived from the module.
 *
 * Deriving it would make the test agree with whatever the module currently
 * lists, so removing a section would still pass — the tautology `CONTRIBUTING.md`
 * forbids. Adding a section here is one line in the pull request that adds it.
 */
const COMPLETE: Fingerprint = {
  tables: ["product"],
  columns: ["product.serial character varying(120) NOT NULL"],
  functions: ["product_requires_provenance abc123"],
  triggers: ["product.product_requires_provenance O"],
  enumLabels: ["product_status.registered"],
  constraints: ["product.product_serial_not_blank CHECK (length(btrim(serial)) >= 2)"],
  indexes: ["product_pkey CREATE UNIQUE INDEX product_pkey ON public.product USING btree (id)"],
  tablePrivileges: ["trustpass_runtime product SELECT"],
  columnPrivileges: ["trustpass_runtime product.status UPDATE"],
  roleMemberships: ["trustpass_migration -> trustpass_owner"],
  oldestLifecycleEvent: ["1"],
};

const withSections = (overrides: Partial<Record<keyof Fingerprint, readonly string[]>>) =>
  ({ ...COMPLETE, ...overrides }) as Fingerprint;

describe("refusing to answer when a section measured nothing", () => {
  it("accepts a fingerprint whose every section has rows", () => {
    expect(missingSections(COMPLETE)).toEqual([]);
  });

  it("reports a section that came back empty", () => {
    // The surviving failure mode. A query that still parses, still runs, and
    // matches nothing compares equal to itself forever.
    expect(missingSections(withSections({ triggers: [] }))).toEqual(["triggers"]);
  });

  it("reports a section that is absent rather than empty", () => {
    const { indexes: _dropped, ...withoutIndexes } = COMPLETE;

    expect(missingSections(withoutIndexes)).toEqual(["indexes"]);
  });

  it("reports every empty section, not only the first", () => {
    expect(missingSections(withSections({ columns: [], tables: [], triggers: [] }))).toEqual([
      "columns",
      "tables",
      "triggers",
    ]);
  });

  it("allows the lifecycle section to be empty, because no events is a real state", () => {
    // `min(id)` over no rows is an answer. Treating it as a broken query would
    // make the fingerprint unusable on a freshly migrated database, and
    // reported-as-empty is a measurement where not-reported-at-all is not.
    expect(missingSections(withSections({ oldestLifecycleEvent: [] }))).toEqual([]);
  });

  it("refuses a privilege section that measured nothing, which is the leak it exists for", () => {
    expect(missingSections(withSections({ columnPrivileges: [] }))).toEqual(["columnPrivileges"]);
  });
});

describe("what moved between two fingerprints", () => {
  it("finds nothing between a fingerprint and itself", () => {
    expect(fingerprintDifferences(COMPLETE, COMPLETE)).toEqual([]);
  });

  it("names a privilege that appeared, with its section", () => {
    const after = withSections({
      columnPrivileges: [...COMPLETE.columnPrivileges, "trustpass_runtime product.serial UPDATE"],
    });

    expect(fingerprintDifferences(COMPLETE, after)).toEqual([
      "+ columnPrivileges: trustpass_runtime product.serial UPDATE",
    ]);
  });

  it("names a trigger that disappeared", () => {
    expect(fingerprintDifferences(COMPLETE, withSections({ triggers: [] }))).toEqual([
      "- triggers: product.product_requires_provenance O",
    ]);
  });

  it("sees a trigger that was only disabled, which stays listed", () => {
    // `tgenabled` moving from O to D is the whole reason it is in the value. The
    // trigger is still in `pg_trigger`, still named, still attached.
    const after = withSections({ triggers: ["product.product_requires_provenance D"] });

    expect(fingerprintDifferences(COMPLETE, after)).toEqual([
      "+ triggers: product.product_requires_provenance D",
      "- triggers: product.product_requires_provenance O",
    ]);
  });

  it("sees history deleted underneath it, which is what the oldest id is for", () => {
    // A count rises when a test appends an event and says nothing. The oldest id
    // moves only when the beginning of history is gone.
    const after = withSections({ oldestLifecycleEvent: ["4"] });

    expect(fingerprintDifferences(COMPLETE, after)).toEqual([
      "+ oldestLifecycleEvent: 4",
      "- oldestLifecycleEvent: 1",
    ]);
  });
});
