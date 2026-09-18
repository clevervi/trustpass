# TrustPass — session notes

The engineering rules live in `CONTRIBUTING.md` and the decisions in
`docs/adr/`. This file covers one thing: the context router that sits in front of
`Read`.

## If a Read comes back denied

You asked for a large file and were handed a map of it instead. The denial names
the map's absolute path and the source's SHA-256.

**The map is navigation, not authority.** It was produced either by a line
scanner or by a cheaper model that was shown the file as untrusted data. Before
changing behaviour that depends on what the code actually does, read the lines
the map names — **a Read with an `offset` and a `limit` of 180 lines or fewer is
never routed through the hook** and always reaches the real file. That exemption
exists so that verification is always available, and it is the reason a summary
is safe to hand over at all.

Asking for the same full read again is allowed. The router notices and gets out
of the way rather than serving the same map twice: if the map did not answer the
question, serving it again answers it no better.

## What never goes to Gemini

`.env*`, keys, certificates, credentials, anything outside the repository, and —
by default — migrations, schema, ADRs, auth, and anything else where the meaning
of the product is decided. The never-transmit list is in code, not in a config
file, for the reason TP-161 gave about triggers: a guard the attacker can switch
off is not a guard. See `context/ai-policy.md`.

## When it is broken, or unwanted

```bash
env -u GEMINI_API_KEY claude
```

Everything keeps working; that is the design, and an integration test asserts it.
`node .claude/scripts/tp-stats.mjs` says what the router did today, and every
token figure there is an estimate from a four-characters-per-token rule of thumb
— it is not billing and does not claim to be.

## Where to look

- `context/architecture.md` — the decision flow, the files, the settings
- `context/ai-policy.md` — what may leave the machine, and what happens when
  Gemini does not answer
- `context/sensitive-paths.txt` — extra paths to keep back; it can add rules and
  can never remove one
