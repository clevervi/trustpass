# Product principles

Rules for deciding what TrustPass builds and, more often, what it refuses to.

A principle that never rejects anything is decoration. Each of these has already
changed a decision in this repository, and the change is cited so the principle
can be checked rather than admired.

## 1. Identity is not authenticity

A persistent record does not prove the physical object is genuine. TrustPass
records who claimed what; it cannot inspect an object and will not pretend to.

No screen may render an unqualified "authentic" badge.

> Applied: the passport lists `physical_authenticity` as permanently
> `not_verifiable`. [ADR 0003](adr/0003-identity-is-not-authenticity.md)

## 2. Unknown is a state, not a gap to fill

Missing evidence is displayed as missing. The system never infers certainty from
silence, and never lets an absence read as either reassurance or accusation.

> Applied: when the API is unreachable the passport says no check was made,
> rather than rendering a passport-shaped layout with blank fields — which would
> read as a product with nothing verified about it.

## 3. A failure to check is never a verdict

"We could not verify this" and "this is not registered" are different answers.
Giving the second when the truth is the first tells a buyer a genuine product is
fake.

> Applied: a mistyped identifier returns `mistyped_trustpass_id`, not `404`. The
> check symbol in [ADR 0004](adr/0004-trustpass-id-format.md) exists so that a
> single misread character is never reported as an unregistered product.

## 4. Claims have issuers

Every meaningful assertion names who made it and what standing they had. A claim
with no author is not evidence.

> Applied: the passport shows the issuer's registration number so a reader can
> check the company in a national registry rather than take TrustPass's word.
> [ADR 0006](adr/0006-issuers-are-identified-by-registration-number.md)

## 5. Claims are listed, never totalled

Identity, provenance, ownership, warranty and condition are separate facts
verified by different means. Collapsing them into one badge or one score invents
a precision none of them has.

There is no trust score. There will not be one until each input is individually
trustworthy, and then it will probably still be a bad idea.

## 6. History is append-only

Lifecycle, ownership and trust events are never silently overwritten. A claim
that is withdrawn keeps its original record beside the withdrawal, its reason and
its author.

> Applied: `suspended` cannot return to `active` in one step. A product that
> quietly became active again would erase the reason it was suspended.
> [Lifecycle](product-lifecycle.md)

## 7. Public means public

A passport exposes verification-relevant facts and nothing else. No names, no
addresses, no contact details, no prices. This binds hardest at ownership, where
the temptation to show a chain of people is strongest.

> Applied: serials are masked to their last four characters, and only when at
> least five stay hidden. A buyer holding the product can confirm the match;
> someone who scraped the code from a listing photograph learns nothing usable.

## 8. Evidence before automation

No intelligence layer before the system produces evidence worth reasoning over.
Fraud detection reads real events — transfers, repairs, disputes, failed
verifications — or it is a guess wearing a model's clothes.

No feature may be described as AI-powered authenticity. That is marketing built
on the failure mode principle 1 exists to prevent.

## 9. Verification before anchoring

Nothing goes on a chain until there is a reason to trust the event being
anchored. Anchoring a claim nobody verified proves only that an unverified claim
was made at a certain time.

Postgres is the system of record. A public chain is optional integrity proof for
events that have already earned it.

## 10. Discovery is not authentication

A QR proves someone had the code. It can be photographed from a listing and
reprinted onto any object.

Nothing may treat a successful scan as evidence about the object in the reader's
hands, and no interface may imply it does.

> Applied: the passport says so beside the code. And a QR is never built from a
> guessed origin — with no configured origin, none is rendered, because a code
> that resolves elsewhere still scans perfectly.

## 11. No feature without a trust outcome

Every addition must improve identity, evidence, ownership, provenance,
verification, condition, or resale confidence. Anything that improves none of
them belongs outside the core product, however good an idea it is.

Frozen by this rule, regardless of merit: tokens, NFTs, a marketplace, listings,
payments, chat, reviews, gamification, a recommendation engine, a native mobile
app.

## 12. Say what was measured

A claim about behaviour is backed by having run it. Building is not running, and
a green test suite is not a green deployment.

Where something has not been checked, the gap is written down rather than
rounded off.

> Applied: v0.3.0 shipped saying its QR had never been scanned by a physical
> phone, because decoding a matrix proves the encoding and not the optics.

---

**How to use this.** When a feature is proposed, find the principle it serves.
If none fits, the answer is no, or the principle list is wrong — and changing a
principle is a pull request of its own, not a paragraph inside a feature.
