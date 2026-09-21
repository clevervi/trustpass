/**
 * Where git is, by absolute path.
 *
 * The reasoning `pg-tools.ts` already applies to `docker`: spawning `"git"`
 * searches PATH, and PATH is a list of directories something else may be able to
 * write to. Prepend a `git` there and whatever spawns it runs somebody else's
 * program with the operator's rights.
 *
 * Extracted here because two scripts need it. The first copy lived in
 * `no-squash.mjs`; a second copy in `mutate.mjs` would have been the same rule
 * written twice, which is how two copies stop agreeing.
 *
 * Forward slashes on the Windows entries, for the reason recorded beside
 * `DOCKER_LOCATIONS`: a backslash before P, r or b is an escape sequence, and
 * the rest of the path vanishes without a word.
 */
import { existsSync } from "node:fs";

const LOCATIONS = [
  "C:/Program Files/Git/cmd/git.exe",
  "C:/Program Files/Git/bin/git.exe",
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
];

export function git() {
  const override = process.env.TP_GIT;

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`TP_GIT is set to "${override}", which does not exist.`);
    }

    return override;
  }

  const found = LOCATIONS.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new Error(
      `git was not found at any of: ${LOCATIONS.join(", ")}. Set TP_GIT to its path.`,
    );
  }

  return found;
}
