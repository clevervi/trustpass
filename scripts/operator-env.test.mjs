import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Every operator script reads the same `.env` the application does.
 *
 * `apps/api`'s `dev` and `start` carried `--env-file-if-exists` and the scripts
 * under `src/scripts/` did not, so seven commands that read `DATABASE_URL` and
 * `TRUSTPASS_ENV` failed on a machine where the API ran fine. Nothing noticed,
 * because nothing was looking — the flag spread by imitation and stopped.
 *
 * It was found while preparing #141's manual run, which is the worst place to
 * find it: that run needs a real terminal, cannot be scripted, and the error
 * arrived *after* the terminal barrier had been satisfied.
 *
 * This is the check that would have found it first. A `package.json` read and a
 * regular expression — no database, no network, and it fails on the eighth
 * script rather than on the operator.
 */

const MANIFESTS = ["apps/api/package.json", "packages/db/package.json"];

/** Anything that runs a file under `src/scripts/` is an operator command. */
const RUNS_A_SCRIPT = /src[/\\]scripts[/\\]/;
const LOADS_ENV = "--env-file-if-exists";

function operatorScripts() {
  return MANIFESTS.flatMap((manifest) => {
    const { scripts = {} } = JSON.parse(
      readFileSync(new URL(`../${manifest}`, import.meta.url), "utf8"),
    );

    return Object.entries(scripts)
      .filter(([, command]) => RUNS_A_SCRIPT.test(command))
      .map(([name, command]) => ({ manifest, name, command }));
  });
}

describe("operator scripts and the environment they read", () => {
  it("finds some, so an empty list cannot pass by accident", () => {
    // The failure this test would otherwise have: a path that stops matching,
    // nothing to check, and a green result meaning nothing.
    assert.ok(operatorScripts().length >= 6, "expected to find the operator scripts");
  });

  for (const { manifest, name, command } of operatorScripts()) {
    it(`${manifest} → ${name} loads the repository .env`, () => {
      assert.ok(
        command.includes(LOADS_ENV),
        `"${name}" runs a script under src/scripts/ and does not load .env.\n` +
          `  ${command}\n` +
          `Add ${LOADS_ENV}=../../.env, the way dev and start do.`,
      );
    });
  }

  it("keeps the flag on the long-running commands too", () => {
    // `dev` and `start` are where the pattern came from. If they lose it, the
    // scripts above are following something that no longer exists.
    const { scripts } = JSON.parse(
      readFileSync(new URL("../apps/api/package.json", import.meta.url), "utf8"),
    );

    for (const name of ["dev", "start"]) {
      assert.ok(scripts[name]?.includes(LOADS_ENV), `apps/api "${name}" stopped loading .env`);
    }
  });

  it("points every one of them at the repository root", () => {
    // A script loading its own package's .env would read a file that does not
    // exist and report nothing, which looks exactly like working.
    for (const { name, command } of operatorScripts()) {
      const [, path] = command.match(/--env-file-if-exists=(\S+)/) ?? [];

      assert.equal(path, "../../.env", `"${name}" loads ${path} rather than the repository root`);
    }
  });
});
