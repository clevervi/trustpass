/**
 * The rule that keeps a write out of a connection that must not change anything.
 *
 * #160 found a test that committed the attack it expected to be refused. #171
 * found six more, still present, and the guard found a seventh on its first run.
 * The damage is real: one `GRANT` weakening the privilege model left a `product`
 * row permanently carrying an attacker's identifier.
 *
 * Only the deciding half is here. The `Mutations` workflow has no Postgres
 * service, so a mutation whose named test needs one matches a skipped test and
 * the runner reports `no-such-test` instead of a verdict — which is why the rule
 * was built as a pure function over a rendered statement rather than as
 * something only an integration test could reach.
 */
export default {
  name: "read-only",
  issue: 171,

  protects: ["packages/db/src/testing/read-only.ts"],

  runner: {
    cwd: "packages/db",
    command: ["pnpm", "exec", "vitest", "run", "src/testing/read-only.test.ts", "--reporter=dot"],
    nameFlag: "-t",
  },

  mutations: [
    {
      file: "packages/db/src/testing/read-only.ts",
      mutations: [
        {
          label: "the allow-list becomes a deny-list, and misses the verbs it forgets",
          test: "refuses a write that is not an INSERT, UPDATE or DELETE",
          from: "  return READS.has(statementVerb(statement));",
          to: '  return !["INSERT", "UPDATE", "DELETE"].includes(statementVerb(statement));',
        },
        {
          label: "an unrecognised verb is let through instead of refused",
          test: "refuses a verb it has never heard of, rather than letting it past",
          from: 'const READS = new Set(["SELECT"]);',
          to: 'const READS = new Set(["SELECT", "MERGE", "FLUMMOX"]);',
        },
        {
          label: "a CTE is admitted, and a writing one cannot be told from a reading one",
          test: "refuses a CTE, because a writing one is indistinguishable without a parser",
          from: 'const READS = new Set(["SELECT"]);',
          to: 'const READS = new Set(["SELECT", "WITH"]);',
        },
        {
          label: "the statement is stringified rather than rendered, losing the verb",
          test: "reads the verb through interpolated parameters",
          from: '  const rendered = typeof statement === "string" ? statement : dialect.sqlToQuery(statement).sql;',
          to: "  const rendered = String(statement);",
        },
        {
          label: "the verb keeps whatever case it was written in",
          test: "admits a plain read",
          from: '  return (rendered.trim().match(/^[a-zA-Z]+/) ?? ["?"])[0].toUpperCase();',
          to: '  return (rendered.trim().match(/^[a-zA-Z]+/) ?? ["?"])[0].toLowerCase();',
        },
        {
          label: "the write reaches the connection and is refused afterwards",
          test: "refuses a write before it reaches the connection",
          from: "        if (!isReadOnly(statement)) {",
          to: "        if (false) {",
        },
      ],
    },
  ],
};
