/**
 * The runner, checked with itself.
 *
 * Not a curiosity. #194 exists because a harness reported results it had never
 * measured, and a harness is the one piece of test infrastructure whose failure
 * is invisible from everything downstream: every set it runs looks healthy
 * because it says so.
 *
 * Its unit tests assert the deciding functions. This asserts that those tests
 * would go red if the functions stopped deciding correctly — which is a
 * different claim, and the one that matters.
 *
 * Patching `mutate.mjs` while `mutate.mjs` is running is safe: the module is
 * loaded once at start, and the patched file is read by the `node --test`
 * process that the run spawns.
 */
export default {
  name: "mutation-runner",
  issue: 194,

  protects: ["scripts/mutate.mjs"],

  runner: {
    cwd: ".",
    command: ["node", "--test", "scripts/mutate.test.mjs"],
    nameFlag: "--test-name-pattern",
  },

  mutations: [
    {
      file: "scripts/mutate.mjs",
      mutations: [
        {
          label: "a mutant that will not build counts as caught",
          test: "does not read a mutant that will not compile as a caught guard",
          from: '    return "broken-build";',
          to: '    return "failed-assertion";',
        },
        {
          label: "the restored run is not consulted",
          test: "does not count a mutant whose test was already failing",
          from: '  if (restored !== "pass") return "already-red";',
          to: "",
        },
        {
          label: "a missing anchor is treated as a surviving mutant",
          test: "refuses when the anchor has moved",
          from: '    return { problem: "anchor-missing" };',
          to: "    return { patched: source };",
        },
        {
          label: "a patch that changes nothing is accepted",
          test: "refuses a patch that changes nothing",
          from: '    return { problem: "no-op" };',
          to: "    return { patched };",
        },
        {
          label: "the selector matches a prefix instead of a path",
          test: "matches a whole path rather than a prefix",
          from: "  return sets.filter((set) => set.protects.some((file) => changed.has(file)));",
          to: "  return sets.filter((set) =>\n    set.protects.some((file) => [...changed].some((c) => c.includes(file))),\n  );",
        },
        {
          label: "a filter that matched no test counts as a pass",
          test: "refuses to read a filter that matched nothing as a pass",
          from: '    return "no-such-test";',
          to: '    return "pass";',
        },
      ],
    },
  ],
};
