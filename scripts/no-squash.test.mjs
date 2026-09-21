/**
 * The comparison that decides whether a squash has landed.
 *
 * Tested against the three shapes this repository's history actually contains,
 * taken from real commits rather than invented: a squash, a rebase merge, and
 * the merge commit a release produces. Getting any of the three wrong makes the
 * check either useless or unusable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLog, squashedCommits } from "./no-squash.mjs";

const FIELD = String.fromCharCode(1);

/** A `git log --format=%h%x01%cn%x01%an <%ae>%x01%s` line. */
const line = (sha, committer, author, subject) => [sha, committer, author, subject].join(FIELD);

describe("telling a squash from the other ways a commit reaches develop", () => {
  it("catches a squash", () => {
    // 1d66634, as it actually stands on develop. Its branch carried one commit
    // by Raishark; this is what the squash left.
    const commits = parseLog(
      line(
        "1d66634",
        "GitHub",
        "SweetZer0 <127355228+clevervi@users.noreply.github.com>",
        "ci: name the check after what it refuses (#182)",
      ),
    );

    assert.equal(squashedCommits(commits).length, 1);
  });

  it("leaves a rebase-merged commit alone", () => {
    // dd1c7a4. The author is who wrote it and the committer is who merged it,
    // which is the outcome the policy exists to keep.
    const commits = parseLog(
      line(
        "dd1c7a4",
        "SweetZer0",
        "Raishark <raivel.studio@gmail.com>",
        "docs(contributing): make the review bar look outside the diff",
      ),
    );

    assert.deepEqual(squashedCommits(commits), []);
  });

  it("leaves a release merge commit alone, which GitHub also authors", () => {
    // The case that makes the committer alone useless as a signal. A merge
    // commit is GitHub's too, and CONTRIBUTING.md requires one for a release —
    // a check that failed on it would fail every release and be switched off.
    const commits = parseLog(
      line(
        "abc1234",
        "GitHub",
        "SweetZer0 <127355228+clevervi@users.noreply.github.com>",
        "Merge pull request #200 from clevervi/develop",
      ),
    );

    assert.deepEqual(squashedCommits(commits), []);
  });

  it("reads several commits, and only flags the squashes among them", () => {
    const commits = parseLog(
      [
        line("aaa1111", "SweetZer0", "Raishark <raivel.studio@gmail.com>", "feat: something"),
        line("bbb2222", "GitHub", "SweetZer0 <x@y>", "fix: something else (#201)"),
        line("ccc3333", "GitHub", "SweetZer0 <x@y>", "Merge pull request #202 from a/b"),
        line("ddd4444", "Raishark", "SweetZer0 <x@y>", "docs: a third thing"),
      ].join("\n"),
    );

    assert.deepEqual(
      squashedCommits(commits).map((commit) => commit.sha),
      ["bbb2222"],
    );
  });

  it("keeps a subject that contains the delimiter rather than truncating it", () => {
    // Nothing produces this, and that is the point: a parser that dropped the
    // tail would lose the part of a subject that identifies the commit, and it
    // would do it silently.
    const subject = `fix: a${FIELD}b`;
    const commits = parseLog(line("eee5555", "GitHub", "SweetZer0 <x@y>", subject));

    assert.equal(commits[0]?.subject, subject);
  });

  it("finds nothing in an empty log, which is the ordinary case", () => {
    assert.deepEqual(squashedCommits(parseLog("")), []);
    assert.deepEqual(squashedCommits(parseLog("\n\n")), []);
  });
});
