/**
 * The guard that tells a squash merge from the other ways a commit arrives.
 *
 * #192 has the reasoning: a squash attributes the commit it produces to whoever
 * opened the pull request rather than to whoever wrote the code. Squash is off
 * in the repository settings and CI cannot read that setting back, so this is
 * what is left — detection after the fact.
 *
 * Four mutations, all caught when #193 was written.
 */
export default {
  name: "no-squash",
  issue: 192,

  protects: ["scripts/no-squash.mjs"],

  runner: {
    cwd: ".",
    command: ["node", "--test", "scripts/no-squash.test.mjs"],
    nameFlag: "--test-name-pattern",
  },

  mutations: [
    {
      label: "the committer is not consulted",
      test: "leaves a rebase-merged commit alone",
      file: "scripts/no-squash.mjs",
      from: 'commit.committer === "GitHub" &&',
      to: "true &&",
    },
    {
      label: "a release merge commit is treated as a squash",
      test: "leaves a release merge commit alone, which GitHub also authors",
      file: "scripts/no-squash.mjs",
      from: '!commit.subject.startsWith("Merge pull request")',
      to: "true",
    },
    {
      label: "nothing is ever flagged",
      test: "catches a squash",
      file: "scripts/no-squash.mjs",
      from: 'commit.committer === "GitHub" &&',
      to: "false &&",
    },
    {
      label: "the subject is truncated at the first delimiter",
      test: "keeps a subject that contains the delimiter rather than truncating it",
      file: "scripts/no-squash.mjs",
      from: "subject: rest.join(FIELD)",
      to: 'subject: rest[0] ?? ""',
    },
  ],
};
