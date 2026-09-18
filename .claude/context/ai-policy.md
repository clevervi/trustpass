# What may be sent to a model that is not Claude

Gemini reads files here so that Claude does not have to read all of them. That is
the entire arrangement, and everything below exists because sending source to a
third party is a decision, not a convenience.

Google states that Free Tier content may be used to improve their products. So
the question "may this file leave the machine" is answered before the question
"would a summary of it be useful".

## The four levels

| Level | Rule | Where it is decided |
| --- | --- | --- |
| **S0** | Never transmitted | **In code**, `scripts/tp-router.mjs` |
| **S1** | Claude reads it directly | Code, plus `sensitive-paths.txt` |
| **S2** | May be delegated | Default for ordinary source |
| **S3** | Delegation is the point | Tests, fixtures — bulk by nature |

**S0 is not configurable, and that is the point.** `.env*`, private keys,
certificates, SSH and cloud material, `credentials`, `secrets`, `.git/`. A
denylist living in a file the repository can edit is one pull request away from
being a shorter denylist — the same argument TP-161 made about a trigger a
compromised runtime could switch off. `sensitive-paths.txt` may **add** rules and
can never remove one, and when it is missing or malformed nothing is delegated at
all.

**Paths are resolved through symlinks first.** `docs/harmless.md` pointing at
`.env` is an `.env`.

**Files outside the repository are never delegated**, whatever they contain.

## What Gemini is, and is not

It is a reader. It returns symbols, findings, dependencies, unknowns and line
ranges. The response schema has no field for an action, a command, a patch or a
suggestion, because a field that does not exist cannot be filled in.

**Its output is untrusted data.** It never becomes a shell command, an edit, a
migration, a git action or a permission change.

**Its input is untrusted too.** Source files contain comments, strings and
fixtures, and a sentence in one of them shaped like an instruction is program
text being reported on, never a request. The system instruction says so, the
source arrives inside a marked region, and a test asserts both.

**Its answers are checked rather than trusted.** Every line range must exist in
the file that was sent, and the source hash travels with the summary. A confident
summary of a file nobody read is worse than no summary, because the first thing
anyone does with a line number is open it.

## When it is not there

Missing key, 401, 403, 429, spent budget, timeout, 5xx, invalid JSON, invalid
schema — every one of them ends the same way:

```
record the reason -> open the circuit -> Claude reads the file directly
```

Auth failures and rate limits get **no retry**: a 429 does not become a 200 by
being asked again. Timeouts and server errors get **one**. Never a loop.

## Killing Gemini

It is meant to survive this. On Git Bash:

```bash
env -u GEMINI_API_KEY claude
```

PowerShell:

```powershell
$env:GEMINI_API_KEY = ""
```

Nothing stops working. Large bulk files still get a map from the local line
scanner, everything else is read directly, and
`node .claude/scripts/tp-stats.mjs` shows the fallbacks. One of the integration
tests runs the real hook with the key unset and asserts exactly this.

## The key itself

It lives in the environment and in process memory. It goes into one HTTP header,
never into a URL, and a test asserts that the request URL contains neither the
key nor a `key=` parameter. Nothing writes it to the cache, the state file or any
log.

If it has ever been pasted into a chat, a terminal that recorded scrollback, or a
file, it is not a secret any more. Rotate it.
