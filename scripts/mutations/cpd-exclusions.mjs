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
        {
          label: "a single star crosses path separators, enlarging the population",
          test: "stops a single star at a path separator",
          from: '      if (part === "*") return "[^/]*";',
          to: '      if (part === "*") return ".*";',
        },
        {
          label: "a double star stops at a path separator, shrinking the population",
          test: "carries a double star across path separators",
          from: '      if (part === "**") return ".*";',
          to: '      if (part === "**") return "[^/]*";',
        },
        {
          label: "the literal parts of a pattern are not escaped",
          test: "treats the dot in an extension as a dot and not as any character",
          from: "      return part.replace(/[.*+?^${}()|[\\]\\\\]/g, String.raw`\\$&`);",
          to: "      return part;",
        },
        {
          label: "the match is not anchored to the whole path",
          test: "anchors at the start, so a path that merely contains the directory misses",
          from: "  return new RegExp(`^${expression}$`).test(path);",
          to: "  return new RegExp(expression).test(path);",
        },
        {
          label: "the population is not filtered by the patterns at all",
          test: "keeps only what a required pattern covers",
          from: "paths.filter((path) => patterns.some((pattern) => matchesPattern(path, pattern)))",
          to: "paths.filter(() => true)",
        },
        {
          label: "the population is left in whatever order it arrived",
          test: "keeps only what a required pattern covers",
          from: "matchesPattern(path, pattern))).sort();",
          to: "matchesPattern(path, pattern))).slice();",
        },
        {
          label: "anything at all may be handed to git as a revision",
          test: "rejects a revision that git would read as an option",
          from: '  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;',
          to: "  return value;",
        },
        {
          label: "the revision shape is not anchored, so an option carrying one passes",
          test: "rejects an option that merely contains a full object name",
          from: "/^[0-9a-f]{40}$/.test(value)",
          to: "/[0-9a-f]{40}/.test(value)",
        },
      ],
    },
  ],
};
