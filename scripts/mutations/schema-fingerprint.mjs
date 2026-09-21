/**
 * The refusal that stops a fingerprint answering when it did not measure.
 *
 * #170 claimed nine attacks leave a database byte-identical, on the evidence of
 * a shell script that no longer exists. #172 rebuilt it, and the most valuable
 * line in the original was never the fingerprint — it was the check that refuses
 * to compare anything until every section is present. A section that matched
 * nothing compares equal to itself forever, so a comparison built from enough of
 * those reports IDENTICAL having measured nothing.
 *
 * Only the pure half is here, and not by preference: the `Mutations` workflow
 * has no Postgres service, so a mutation whose named test needs a database gets
 * a skipped test and a `no-such-test` verdict rather than an answer.
 */
export default {
  name: "schema-fingerprint",
  issue: 172,

  protects: ["packages/db/src/testing/schema-fingerprint.ts"],

  runner: {
    cwd: "packages/db",
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "src/testing/schema-fingerprint.test.ts",
      "--reporter=dot",
    ],
    nameFlag: "-t",
  },

  mutations: [
    {
      file: "packages/db/src/testing/schema-fingerprint.ts",
      mutations: [
        {
          label: "nothing is ever reported as missing",
          test: "reports a section that came back empty",
          from: "    .filter((name) => (sections[name]?.length ?? 0) === 0)",
          to: "    .filter(() => false)",
        },
        {
          label: "an absent section is treated as a present one",
          test: "reports a section that is absent rather than empty",
          from: "(sections[name]?.length ?? 0) === 0",
          to: "(sections[name]?.length ?? 1) === 0",
        },
        {
          label: "every section may be empty, so the refusal never fires",
          test: "refuses a privilege section that measured nothing, which is the leak it exists for",
          from: "    .filter((name) => !MAY_BE_EMPTY.includes(name as SectionName))",
          to: "    .filter(() => false)",
        },
        {
          label: "the lifecycle exception is dropped, so a fresh database is refused",
          test: "allows the lifecycle section to be empty, because no events is a real state",
          from: 'const MAY_BE_EMPTY: readonly SectionName[] = ["oldestLifecycleEvent"];',
          to: "const MAY_BE_EMPTY: readonly SectionName[] = [];",
        },
        {
          label: "only additions are reported, so a deleted object is invisible",
          test: "names a trigger that disappeared",
          from: "    for (const value of before[name]) if (!now.has(value)) differences.push(`- ${name}: ${value}`);",
          to: "",
        },
        {
          label: "only removals are reported, so a granted privilege is invisible",
          test: "names a privilege that appeared, with its section",
          from: "    for (const value of after[name]) if (!was.has(value)) differences.push(`+ ${name}: ${value}`);",
          to: "",
        },
      ],
    },
  ],
};
