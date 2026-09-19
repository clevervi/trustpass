-- A credential can now prove itself.
--
-- `credential` has existed since v0.5.0 carrying who and when, with one hole
-- left open on purpose: "No secret is stored here. What proves possession — a
-- hash, a public key, an issuer and subject — is deliberately out of this
-- phase." ADR 0014 fills exactly that hole and nothing else. No column here
-- changes what the table already meant.
--
--   handle         the public half. Stored in clear because it identifies a
--                  credential and proves nothing, and UNIQUE because both
--                  alternatives to refusing a collision are silent: one
--                  overwrites a credential, the other authenticates the wrong
--                  actor. It is what makes verification an indexed lookup
--                  rather than a scan, so the digest never becomes the key.
--
--   secret_digest  SHA-256, as bytes. Computed in Node and never by pgcrypto,
--                  because hashing in SQL puts the raw secret into a query
--                  string where `log_statement` can catch it.
--
-- Both nullable, and the checks carry the rules the types cannot.
--
-- `credential_secret_belongs_to_api_key` runs in one direction only: a handle
-- implies `api_key`, and an `api_key` does NOT imply a handle. The symmetric
-- version was written first and Postgres refused it against 180 existing rows:
--
--   ERROR: check constraint "credential_secret_matches_kind" of relation
--          "credential" is violated by some row
--
-- Those credentials were created while this table stored no secret at all.
-- Satisfying a symmetric constraint would mean either inventing a digest for
-- them or writing `revoked_at` on rows nobody revoked — and per ADR 0011 §7 a
-- revocation is a fact that it happened, not a convenient way to mark a row
-- unusable. Neither is a migration's business.
--
-- Leaving them legal is safe structurally rather than hopefully: verification
-- looks a credential up BY handle, so a row without one is unreachable from
-- every path that authenticates. A secretless `api_key` fails to authenticate,
-- which is the direction a failure is allowed to go.
--
-- The runtime's grant is `GRANT SELECT ON TABLE credential` — table-level, so
-- these columns are covered. Checked rather than assumed: a column-enumerated
-- grant would have left the verifier unable to read the two columns it exists
-- to read, and would have failed at the first request rather than here.
--
-- Nothing here grants INSERT. Issuance stays off the API in this phase, which
-- is ADR 0014 §8 and why "creating a credential needs an authenticated actor"
-- does not need solving yet.

ALTER TABLE "credential" ADD COLUMN "handle" varchar(11);--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "secret_digest" "bytea";--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_handle_key" UNIQUE("handle");--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_secret_belongs_to_api_key" CHECK ("credential"."handle" IS NULL OR "credential"."kind" = 'api_key');--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_secret_is_whole" CHECK (("credential"."handle" IS NULL) = ("credential"."secret_digest" IS NULL));--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_digest_is_sha256" CHECK ("credential"."secret_digest" IS NULL OR octet_length("credential"."secret_digest") = 32);--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_handle_is_whole" CHECK ("credential"."handle" IS NULL OR length("credential"."handle") = 11);