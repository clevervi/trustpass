/**
 * The guard that checks the duplication exclusions are still in force.
 *
 * #197 is about a configuration file that looked plausible and was ignored.
 * `.sonarcloud.properties` replaced it and nothing checked that the replacement
 * kept working — the same failure one level along. This is that check, and these
 * are the ways it could stop being one.
 */
export default {
  name: "cpd-exclusions",
  issue: 197,

  protects: ["scripts/cpd-exclusions.mjs"],

  runner: {
    cwd: ".",
    command: ["node", "--test", "scripts/cpd-exclusions.test.mjs"],
    nameFlag: "--test-name-pattern",
  },

  mutations: [
    {
      file: "scripts/cpd-exclusions.mjs",
      mutations: [
        {
          label: "a file missing from the analysis is accepted",
          test: "rejects a file that is not in the analysis at all",
          from: '  if (!component) return "absent from the analysis";',
          to: "  if (!component) return null;",
        },
        {
          label: "duplication that is still counted is accepted",
          test: "rejects a file that still contributes duplication",
          from: "  if (duplication !== 0) return",
          to: "  if (false) return",
        },
        {
          label: "an unreported duplication measure counts as zero",
          test: "rejects a file whose duplication was not reported",
          from: '  if (duplication === null) return "no duplication measure";',
          to: "",
        },
        {
          label: "the contract stops requiring what the file must exclude",
          test: "reports a required pattern that has been dropped",
          from: "  return REQUIRED_PATTERNS.filter((required) => !declared.includes(required));",
          to: "  return [];",
        },
        {
          label: "a commented-out setting counts as a setting",
          test: "is not fooled by a commented-out line",
          from: '    .find((l) => l.startsWith("sonar.cpd.exclusions="));',
          to: '    .find((l) => l.includes("sonar.cpd.exclusions="));',
        },
      ],
    },
  ],
};
