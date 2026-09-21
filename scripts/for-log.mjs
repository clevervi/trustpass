/**
 * Anything from outside, on its way into a message somebody will read.
 *
 * A newline in a value and the log says whatever the person who set that value
 * wanted it to say — `jssecurity:S5145`. The values are untrusted even when the
 * person setting them today is the person reading the log: a ruleset's check
 * names come from a web interface, a branch name comes from `.git/HEAD`, and
 * neither is this program's.
 *
 * Extracted because two scripts need it. The first copy was private to
 * `merge-bar.mjs`; a second copy in `cpd-exclusions.mjs` would have been the
 * same rule written twice, which is how two copies stop agreeing — the argument
 * `git-path.mjs` already makes for `git`.
 */
export function forLog(value) {
  // Character codes rather than a regular expression range. The range was
  // written as an escape sequence and the formatter rewrote it into the literal
  // control characters it denotes — which still worked, was unreadable, and left
  // a test that appeared to say `includes("")`. A guard nobody can read is a
  // guard somebody deletes.
  const readable = Array.from(String(value), (character) => {
    const code = character.codePointAt(0);

    return code < 0x20 || code === 0x7f ? " " : character;
  });

  return readable.join("").slice(0, 120);
}
