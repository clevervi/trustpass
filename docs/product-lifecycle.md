# Product lifecycle

A product's **status** is where it is now. Its **lifecycle events** are what has
happened to it. Status is singular and mutable; history is plural and
append-only. They are different tables for that reason, and conflating them is
the mistake this page exists to prevent.

## States

```
                  ┌─────────┐
     created ───► │  draft  │
                  └────┬────┘
                       │
                       ▼
                ┌────────────┐        ┌───────────┐
                │ registered │ ◄────► │ suspended │
                └─────┬──────┘        └─────┬─────┘
                      │  ▲                  ▲
                      ▼  │                  │
                  ┌────────┐                │
     created ───► │ active │ ───────────────┘
                  └────┬───┘
                       │
                       ▼
                  ┌─────────┐
                  │ retired │   (terminal)
                  └─────────┘
```

Every state can reach `retired`. Nothing leaves it.

| Status       | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `draft`      | A row exists. It claims nothing. The default.                           |
| `registered` | TrustPass holds an established record for this product.                 |
| `active`     | Ownership has been established and the product is in an owner's hands.  |
| `suspended`  | Something is wrong: a fraud flag, a theft report, a disputed claim.      |
| `retired`    | End of life. Terminal.                                                   |

### `registered` says a record exists, not who vouches for it

It used to read "the issuer stands behind the record", and that stopped being
true when [ADR 0007](adr/0007-identity-may-begin-after-manufacture.md) made
enrolment a first-class path. A person enrolling a device they hold is not an
issuer and vouches for nothing beyond having read a serial — yet their product
has to land somewhere, and the only honest landing place is `registered`.

Keeping the old wording would have meant either a state that lies about
holder-enrolled products, or a sixth state (`enrolled`) whose only job is to
carry a distinction that belongs elsewhere.

**The status says a record exists. Who vouches for it, and with what standing,
is a separate question with a separate answer:**

| Question | Where it is answered |
| --- | --- |
| Is there a record? | `status` |
| Where did the record come from? | `origin` — `manufacturer`, `supply_chain`, `holder` |
| Who acted, in what capacity? | the lifecycle event's actor |
| Has anyone checked the issuer? | the `issuer` verification claim |

That separation is why the state machine stays five states while the trust model
keeps getting richer. A status is a position in a lifecycle; it is not a summary
of how much anyone should believe.

**`active` is a consequence, not a label.** Ownership does not exist until
v0.5.0, so today nothing can make it true and `changeProductStatus` refuses to
set it — in the type, so the compiler enforces it rather than a reviewer.

Its description also used to end "the only state whose passport is worth
reading". That was true when the only way in was an issuer registering a
product, and enrolment made it false: a `registered` product carries an
identity, its claims, its history and an explicit unknown period before the
record began. That is a passport well worth reading, and it is the one most
readers will meet first.

**Every state has a passport worth reading.** What changes between them is what
the passport is able to say, and saying that accurately is the entire job.

## Allowed moves

| From         | To                                  |
| ------------ | ----------------------------------- |
| `draft`      | `registered`, `retired`             |
| `registered` | `active`, `suspended`, `retired`    |
| `active`     | `suspended`, `retired`              |
| `suspended`  | `registered`, `retired`             |
| `retired`    | — nothing                           |

A product may also be created directly as `draft` or `registered`, and as
nothing else. Without that rule the table above is bypassed entirely by
inserting the end state: a product born `active` was never registered by anyone.

Setting a status to the value it already holds is always allowed. An update that
changes a brand or a serial leaves status alone, and treating that as a
transition would block every ordinary write.

## Two rules that are deliberately inconvenient

**`suspended` cannot go straight back to `active`.**

Suspension exists because something is wrong. A product that quietly becomes
active again erases the reason it was ever suspended — and the passport would
show no trace of the episode to the next buyer. Clearing a suspension returns
the product to `registered`; activating it again is a separate act, recorded
separately. Two deliberate steps instead of one silent one.

**`retired` is terminal.**

A product that can come back from end of life makes the word meaningless on a
passport. Recycled, destroyed and decommissioned units must stay that way, or
"retired" stops being evidence of anything.

Retirement also releases the product's serial. One issuer may hold only one
**live** identity per serial — every status except `retired` — so retiring a unit
is what allows a warranty replacement to be registered under the serial it
replaces. Moving a product to `retired` is therefore not only an end state; it
is the act that frees the serial. See `product_live_issuer_serial_idx`.

## Where this is enforced

In two places, deliberately.

| Layer                                      | Why                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/db/src/domain/product-status.ts` | Typed errors naming both states, for the API to report                   |
| `drizzle/0002_product_status_transition_guard.sql` | A trigger no write path can sidestep                           |

The TypeScript table is the source of truth a reader should consult. The trigger
repeats it because a rule that lives only in application code is bypassed by the
first path that writes without going through it, and status gates what the public
passport is allowed to claim.

Two copies drift. So `product-status.integration.test.ts` walks **every**
source-to-target pair and asserts the database agrees with the table — 25 pairs,
checked against the real trigger. A divergence is a failing test rather than a
silent hole. That assertion has been confirmed to fail when the two are made to
disagree.

An illegal move raises SQLSTATE `TP001`, a project-defined code, so a caller can
answer "that move is not allowed" rather than "the database said no".

## Not covered here

- **Who** may trigger a transition — TP-053.
- The **history** of transitions, as lifecycle events — TP-050. Until that
  exists, a status change leaves no record of why it happened.
