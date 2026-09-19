# 0014. A credential says who, not what

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Nothing authenticates. Measured before deciding anything:

```
rg -i "bearer|jwt|authorization header|apiKey|verifyToken|authenticate" apps/api/src
-> nothing
```

`actor_kind` is whatever the request body says it is. A caller can enrol as
`holder` for a product they have never held, or register against an organization
they have no relationship with, and every guarantee built in #119, #126, #128 and
#130 protects the record from a compromised *runtime* while none of them decides
whether the caller is who they claim to be.

ADR 0011 §5 already settled the shape:

> Authentication resolves a credential to an actor, and authorisation is a
> separate lookup of that actor's grants valid at the time of the request.

And the `credential` table has existed since v0.5.0 carrying exactly that idea —
`actor_id`, `kind`, `issued_at`, `expires_at`, `revoked_at`, with checks — and
one deliberate hole:

> No secret is stored here. What proves possession — a hash, a public key, an
> issuer and subject — is deliberately out of this phase.

That hole is the thing authentication needs. This ADR fills it and nothing else.

## Decision

### 1. Identity: a credential resolves to exactly one actor

```
Credential → Actor → Organization → Grant → Capacity → Action
```

Authentication ends at the second arrow. Everything to its right is ADR 0009 and
ADR 0011, already built, and is not re-decided here.

### 2. Credential state

Three states, and they already exist as columns rather than as an enum, because
each is a fact with a time rather than a label:

| State | How it is known |
| --- | --- |
| active | `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` |
| expired | `expires_at <= now()` |
| revoked | `revoked_at IS NOT NULL` |

**The boundary is pinned deliberately.** A credential whose `expires_at` is
exactly `now()` is expired — `>` and not `>=`. It is one character and it is the
kind of place edge-case bugs live, so it is written here rather than decided
twice by two people reading the same sentence differently.

`revoked_at` is checked without comparing it to anything. A revocation is a fact
that it happened, not a time it takes effect, and `revoked_at > now()` would be
a scheduled revocation — a different feature nobody asked for.

**Revoked never resurrects.** `revoked_at` is written once and the verification
query consults it on every request, which is a property the transport decision
below is chosen to preserve.

Revoking says nothing about what was recorded under the credential. ADR 0011 §7
already argued that, and it is repeated here only because authentication is
where somebody would be tempted to undo it.

### 3. The secret: generated here, never stored, never a password

**The server generates it.** 256 bits from a cryptographic source, rendered as
text the client stores. The client never chooses it and the server never sees it
again.

**The database stores a SHA-256 of it, and that is a deliberate choice that
would be wrong for a password.** A user-chosen password needs a slow,
salted, memory-hard function because the search space is small enough to walk. A
256-bit random secret has no search space to walk, and a slow hash on every
request buys nothing but latency. The threat models are different and the
storage must not be copied from one to the other.

So the ADR says it in the form somebody will read before implementing:

```
credential secret:  server-generated, 256-bit, random
                    NOT a user-chosen password
at rest:            SHA-256 of the secret
                    NOT bcrypt/argon2, and not because they are worse
```

**The format is part of the decision, not of the implementation.**

```
tp_<env>_<handle>_<secret>

tp_live_7f3a91c4_9mK2x…          46 characters after the prefix
   |     |         |
   |     |         └─ 256 bits from crypto.randomBytes(32), base64url
   |     └─────────── 64 bits, the indexed lookup handle, stored in clear
   └───────────────── environment, so a staging secret pasted into production
                      fails as a secret rather than as a permission
```

The handle is why verification is an indexed lookup and not a scan. Without it
the hash becomes the index, and a hash used as a primary lookup key is a value
whose leak through a log or an error message is more interesting than it needs
to be. It is stored in clear on purpose: it identifies a credential and proves
nothing.

The prefix is not decoration. A token pasted into the wrong environment should
fail because it is not a credential there, not because the environment happened
to reject it for some other reason — and a secret scanner can be taught one
literal string.

**Comparison is `timingSafeEqual` over the two digests**, not `===` over
strings. Both are 32 bytes, which is the length requirement that function has,
and the comparison happens only after the handle has already narrowed it to one
row. Nothing compares raw secrets.

### 4. Transport: `Authorization: Bearer`, and not a cookie

```
Authorization: Bearer <credential-id>.<secret>
```

**Not a cookie.** A browser-attached credential brings CSRF, `SameSite`, and
turns the CORS policy settled in #121 from a boundary into load-bearing security.
There is no browser client for the write endpoints. Nothing is paid for that.

**Not JWT.** Its defining property is verification without consulting the
database. `revoked_at` requires consulting the database on every request, so a
JWT here means paying for statelessness — JWKS, rotation, issuer, audience,
claims — and then adding a denylist to give it back. If federation or a second
service earns it later, `credential.kind` already has `federated` waiting and
that decision gets its own ADR.

**Browser-based authenticated writes are out of scope and stay out** until CORS,
CSRF and cookie policy are reviewed together. Written down so that "there is auth
now" does not later become a reason to add a cookie without that review.

### 5. The principal is minimal

```ts
interface AuthenticatedPrincipal {
  readonly actorId: number;
  readonly credentialId: number;
}
```

Nothing about organizations, memberships, roles or what the actor may do. A
principal carrying `canEnrol` is a role-based access control system wearing a
different name, and TrustPass already has an authority model that is better than
one: grants pinned to the moment they were used.

### 6. Nothing in the request body is identity

`actor_kind`, `actor_id`, `organization_id` and `credential_id` in a request body
are input about the *thing being described*, never about who is describing it.
The principal comes from the credential and from nowhere else.

This is the one that needs a test rather than a sentence, because it is the
current behaviour that is wrong: today the server believes the body.

### 7. Failures say the same thing

Absent, malformed, unknown, expired and revoked all produce one response. A
caller learning *which* of those applies learns whether a credential exists, and
that is the same oracle #143 removed from `/enrolments` for the same reason.

### 8. Bootstrap: the first credential is not issued over HTTP

There is a circularity — creating a credential needs an authenticated actor, and
the first actor has none. It is resolved by not putting issuance on the API at
all in this phase.

```
operator, with the superuser credential
        -> pnpm db:issue-credential --actor <id> --label <name>
        -> the secret is printed once, to the terminal, and never stored
        -> the runtime only ever verifies
```

This matches what the runtime is already allowed to do: #119's grant matrix gives
it `SELECT` on `credential` and nothing else. **Issuance through the API would
need an `INSERT` grant**, which is a migration and a decision, and neither
belongs in the issue that introduces verification.

Rotation is issuing a second credential and revoking the first — which the table
already supports, and which is why `label` exists. Loss is revocation followed by
issuance. Neither needs a new mechanism.

**The secret is shown once, to a terminal, and that is a delivery path with a
known weakness.** Terminal scrollback persists, and a session in this repository
has already had a live API key pasted into a transcript and needed rotating. So:

- the command writes the secret to stdout and to nothing else — no file, no log,
  no state, and never a return value another process captures;
- it refuses to run when `CI` is set, because a secret in a build log is a
  secret in an artefact that outlives the build;
- `provision-roles.ts` already sets `log_statement = 'none'` for its own session
  and the same applies here;
- the operator is told, in the output, that scrollback is not storage.

That does not make the path safe. It makes its one weakness explicit, which is
the most an ADR can honestly do for something a human has to copy.

### 9. The attack cases are written before the thing that passes them

Not a testing preference — an ordering decision, recorded because the order is
easy to reverse under pressure and the reversal is invisible afterwards. Every
one of these fails today, and each must fail for its own reason before any
middleware exists to satisfy it.

| Case | Must hold |
| --- | --- |
| Credential A, body asserting `actor_kind`, `actor_id`, `organization_id`, `membership_id` and `credential_id` of somebody else | principal is A |
| Credential A, body asserting A's own values | principal is A — **because of the credential**, not because the body agreed |
| A revoked credential | refused, and still refused after a restart |
| A credential expiring exactly at `now()` | expired |
| No header, a malformed header, an unknown handle, a right handle with a wrong secret | one indistinguishable refusal |
| Any of the above | the presented secret appears in no log, error body, exception or test artefact |

The second row is the one that is easy to skip and the one that matters. A test
where the body happens to agree with the credential passes whether identity came
from the credential or from the body, and proves nothing about which.

## What this ADR does not decide

- **Authorization.** ADR 0009 and ADR 0011 own it. An actor whose membership
  ended still authenticates as that actor; what they may do under that
  organization is the grant lookup, and it runs afterwards. An earlier draft of
  #141 put that case under authentication, which is precisely the boundary this
  section exists to hold.
- **Rate limiting.** #120.
- **Sessions, refresh, CSRF, a credential management interface.** None of them
  follow from bearer authentication, and each would be a decision of its own.

## Consequences

- A migration adds the lookup handle and the hash to `credential`. The table's
  existing shape is unchanged: this fills the hole v0.5.0 left open on purpose.
- Every write endpoint gains a principal and stops reading identity from its
  body. `POST /enrolments` and `POST /products` are the two that exist.
- **#120's remaining criterion becomes buildable, and not by authentication
  alone.** Recovering your own enrolment identifier needs proof of entitlement to
  *that* enrolment; being the same actor does not establish it. What this ADR
  provides is the actor, which is the part that was missing.
- The operator gains a command and a responsibility: a secret printed once.

## Alternatives rejected

**JWT.** Above. The short form: paying for statelessness and then not being
stateless.

**A cookie.** Above. The short form: buying CSRF in order to avoid a header.

**Storing the secret with a password hash.** Slower on every request, for a
threat that does not exist against 256 random bits. Rejected with the reason
written into the decision, because "we used argon2" reads as caution and would
here be a misreading of what is being protected.

**Issuance over HTTP in this phase.** It needs an `INSERT` grant the runtime does
not have, an authorization model for who may issue, and a delivery mechanism for
the secret. Three decisions hiding inside one endpoint.
