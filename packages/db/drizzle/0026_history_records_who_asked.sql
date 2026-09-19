-- History records who asked.
--
-- `lifecycle_event` has recorded `actor_kind` since TP-051 — what kind of thing
-- acted — and had nowhere to say **which** one. That was correct while nothing
-- authenticated: naming an actor the system had not identified would have been
-- a guess written into an append-only table.
--
-- #141 produced an identified actor, so the column can hold a fact now.
--
--   actor_id     the authenticated principal, from the presented credential
--                and from nowhere else. No request can set it or influence it.
--   actor_kind   what the operation is. A literal in the code path that writes
--                the event, and also never read from a request.
--
-- The separation is ADR 0014 §6 and it is not cosmetic. A body saying
-- `actor_kind: "authority"` does not make its sender an authority; whether an
-- actor may act as a kind is a grant lookup that runs after authentication and
-- is not decided here (#152).
--
-- Nullable, and for the same reason 0025's handle is: every event written
-- before this existed has no principal to name. Backfilling one would make the
-- history say a specific actor did something nobody recorded, and per ADR 0011
-- §7 what was recorded at the time is itself a fact. A null means "written
-- before the system knew who was asking", which is true of those rows.
--
-- ON DELETE RESTRICT, like every other reference into this table. An actor with
-- history cannot be deleted from under it — deleting one would silently rewrite
-- who did what, which is the thing the append-only trigger exists to prevent
-- through a different door.
--
-- The runtime's grant is `GRANT INSERT, SELECT ON TABLE lifecycle_event`, which
-- is table-level and covers columns added afterwards. Checked rather than
-- assumed, the same way 0025's was.

ALTER TABLE "lifecycle_event" ADD COLUMN "actor_id" bigint;--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "lifecycle_event_actor_idx" ON "lifecycle_event" USING btree ("actor_id");