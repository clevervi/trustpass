/**
 * The sanitiser standing between an outside value and a log somebody trusts.
 *
 * `jssecurity:S5145`. A ruleset's check names come from a web interface and a
 * branch name comes from `.git/HEAD`; neither is this program's, and a newline
 * in either lets whoever set it write its own line into a CI log.
 *
 * It was private and untested for as long as one script used it, which is most
 * of why a second copy was nearly written rather than it being shared.
 */
export default {
  name: "for-log",
  issue: 197,

  protects: ["scripts/for-log.mjs"],

  runner: {
    cwd: ".",
    command: ["node", "--test", "scripts/for-log.test.mjs"],
    nameFlag: "--test-name-pattern",
  },

  mutations: [
    {
      file: "scripts/for-log.mjs",
      mutations: [
        {
          label: "nothing is stripped at all",
          test: "stops a newline fabricating a line",
          from: '    return code < 0x20 || code === 0x7f ? " " : character;',
          to: "    return character;",
        },
        {
          label: "delete is allowed through, sitting above the control range",
          test: "removes delete, which sits above the control range",
          from: "code < 0x20 || code === 0x7f",
          to: "code < 0x20",
        },
        {
          label: "the range widens until it eats ordinary text",
          test: "keeps a non-ASCII character, because it is text and not a control",
          from: "code < 0x20 || code === 0x7f",
          to: "code < 0x20 || code >= 0x7f",
        },
        {
          label: "the length bound is dropped",
          test: "bounds the length, so one value cannot fill the log",
          from: '  return readable.join("").slice(0, 120);',
          to: '  return readable.join("");',
        },
      ],
    },
  ],
};
