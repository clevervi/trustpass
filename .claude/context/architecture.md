# How a Read becomes a map

```
Claude: Read(file)
        |
   PreToolUse hook  (hooks/route-read.mjs)
        |
   +----+-----------------------------------------+
   | limit <= 180 lines?          -> pass through |  verification always
   | path does not resolve?       -> pass through |  reaches the real file
   | S0 or S1?                    -> pass through |
   | outside the repository?      -> pass through |
   | fewer than 400 lines?        -> pass through |
   +----+-----------------------------------------+
        | eligible
   SHA-256 of the source
        |
   cache key = sha256(source + model + prompt + router + extractor versions)
        |
   +----+----+
   |  cache  | hit ----------------------------+
   +----+----+                                 |
        | miss                                 |
   local line scanner                          |
        |                                      |
   enough for an S3 file? --- yes -------------+
        | no                                   |
   budget and circuit -- unavailable --> pass through
        | available                            |
   Gemini (structured output, one retry max)   |
        | failed --> open circuit --> pass through
        | ok                                   |
   validate ranges, cache the answer ----------+
                                               |
                                        write the map
                                               |
                                     deny the original Read
                                               |
                              Claude reads the map, then the
                              specific lines it actually needs
```

**The cache is consulted before the budget and before the circuit.** A summary
already paid for does not need Gemini to be reachable — which is why an
exhausted quota still serves one.

**Every branch that is not an explicit deny ends in a pass through.** A hook that
times out does not block the tool call, and a hook that exits without printing a
decision does not block it either, so the safe outcome is also the default one.

## Why 400 lines

Counted, rather than chosen. Against this repository:

```
>= 200 lines   30 files
>= 300 lines   12 files
>= 400 lines    7 files
>= 500 lines    3 files
>= 600 lines    0 files
```

The threshold was originally 600, which would have meant the router never fired
here once. At 400 it has seven files to work with. That is a small number and the
honest one: on a codebase this size the mechanism matters more than the saving.

## Files

| File | What it owns |
| --- | --- |
| `hooks/route-read.mjs` | The hook. Reads stdin, writes the decision, never throws |
| `scripts/tp-router.mjs` | Sensitivity, symlink resolution, the routing decision. No I/O of its own |
| `scripts/tp-context.mjs` | Hashing, cache key, the local line scanner, the map |
| `scripts/tp-gemini.mjs` | The only file that talks to Google. Returns results, never throws |
| `scripts/tp-state.mjs` | Counters, budget, circuit breaker, under a filesystem lock |
| `scripts/tp-stats.mjs` | What happened today |

The router takes its dependencies as arguments rather than importing them. That
is what lets the tests drive a 429, a timeout, a corrupt policy file and a
symlink pointing at a secret with no network, no key, and no Gemini.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | unset | Unset means the router works without Gemini |
| `TP_GEMINI_MODEL` | `gemini-3.8-flash` | |
| `TP_GEMINI_DAILY_BUDGET` | `25` | An internal guardrail, not Google's quota |
| `TP_GEMINI_TIMEOUT_SECONDS` | `8` | |
| `TP_GEMINI_MAX_RETRIES` | `1` | Transient failures only |
| `TP_GEMINI_FAILURE_COOLDOWN_SECONDS` | `300` | How long the circuit stays open |
| `TP_GEMINI_THINKING_LEVEL` | `low` | Gemini 3.8 Flash supports `low`, `medium` (default) and `high`. **`minimal` is not supported and returns an error.** `low` because this is extraction, not reasoning |
| `TP_STATE_DIR`, `TP_CACHE_DIR` | under `.claude/` | For the tests. Deliberately **not** a repository-root override, because a variable that moves the repository boundary moves what counts as "outside the repository" |

## Running the tests

```bash
node --test ".claude/tests/*.test.mjs"
```

No network, no API key, no Gemini. A suite that needed the optional dependency
would be testing the wrong thing.
