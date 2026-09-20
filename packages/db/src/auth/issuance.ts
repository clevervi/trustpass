import type { ActorKind } from "../schema/actor.js";
import { actorKind } from "../schema/actor.js";

/**
 * Deciding whether a credential may be issued, and to whom, without doing it.
 *
 * Pure and total, for the reason `credential-token.ts` gives about parsing: the
 * half of this command that is easiest to get wrong is the half that touches no
 * database and no terminal, and it is also the half nobody can test by running
 * the real thing — a test that needed an interactive terminal would not run in
 * CI, which is precisely where the CI barrier has to be proven.
 */

/** Why the command stopped. Never a sentence — the caller renders those. */
export const REFUSAL = {
  /** stdout is redirected, piped, or otherwise not a person looking at it. */
  NOT_A_TERMINAL: "not_a_terminal",
  /** A runner. Some allocate a TTY, so this is checked separately. */
  CONTINUOUS_INTEGRATION: "continuous_integration",
  NO_ACTOR: "no_actor",
  AMBIGUOUS_ACTOR: "ambiguous_actor",
  ACTOR_NOT_AN_ID: "actor_not_an_id",
  UNKNOWN_ACTOR_KIND: "unknown_actor_kind",
  NO_LABEL: "no_label",
  LABEL_TOO_SHORT: "label_too_short",
  UNKNOWN_ARGUMENT: "unknown_argument",
  /** A flag whose value is another flag, which is a forgotten argument. */
  MISSING_VALUE: "missing_value",
} as const;

export type RefusalReason = (typeof REFUSAL)[keyof typeof REFUSAL];

/** Either an actor that exists, or one this command is being told to create. */
export type ActorChoice =
  | { readonly existing: number }
  | { readonly create: { readonly kind: ActorKind; readonly displayName: string } };

export interface IssuanceRequest {
  readonly label: string;
  readonly actor: ActorChoice;
}

export type Refused = { readonly refused: RefusalReason };

/**
 * Whether the secret can be shown to a person rather than captured by a file.
 *
 * Two checks and not one. `process.stdout.isTTY` closes the pipe and the
 * redirect; `CI` closes the runners that allocate a terminal anyway. Either
 * alone leaves a gap, and the gap is a secret in a build log.
 */
export function canDeliverSecret(where: {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): RefusalReason | null {
  if (!where.isTTY) {
    return REFUSAL.NOT_A_TERMINAL;
  }

  // Any non-empty value. Runners set this to `1`, `yes`, `True` and their own
  // name, and a check that only knows `"true"` is a check that passes on the
  // runner that matters. Empty is treated as unset, because that is how a
  // shell unsets a variable in practice.
  if ((where.env.CI ?? "") !== "") {
    return REFUSAL.CONTINUOUS_INTEGRATION;
  }

  return null;
}

/** `credential_label_not_blank` in the schema: `length(trim(label)) >= 2`. */
const MINIMUM_LABEL = 2;

const KINDS: readonly string[] = actorKind.enumValues;

/**
 * Reads the arguments, or says which one it could not.
 *
 * Refuses an unknown flag rather than ignoring it. A command that silently
 * drops `--force` teaches an operator that the flag worked.
 */
export function parseIssuanceArgs(argv: readonly string[]): IssuanceRequest | Refused {
  let actorId: string | undefined;
  let created: { kind: string; displayName: string } | undefined;
  let label: string | undefined;

  // A value that is itself a flag is a forgotten argument, not a value. Without
  // this, `--actor --label "nightly"` reads the label as the actor id and then
  // reports whatever the leftover word looked like — a refusal that sends the
  // operator to fix the wrong thing.
  const valueAt = (index: number): string | undefined => {
    const candidate = argv[index];
    return candidate === undefined || candidate.startsWith("--") ? undefined : candidate;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--actor") {
      actorId = valueAt(index + 1);
      if (actorId === undefined) return { refused: REFUSAL.MISSING_VALUE };
      index += 1;
    } else if (flag === "--create-actor") {
      const kind = valueAt(index + 1);
      const displayName = valueAt(index + 2);
      if (kind === undefined || displayName === undefined) {
        return { refused: REFUSAL.MISSING_VALUE };
      }
      created = { kind, displayName };
      index += 2;
    } else if (flag === "--label") {
      label = valueAt(index + 1);
      if (label === undefined) return { refused: REFUSAL.MISSING_VALUE };
      index += 1;
    } else {
      return { refused: REFUSAL.UNKNOWN_ARGUMENT };
    }
  }

  if (actorId !== undefined && created !== undefined) {
    return { refused: REFUSAL.AMBIGUOUS_ACTOR };
  }

  if (actorId === undefined && created === undefined) {
    return { refused: REFUSAL.NO_ACTOR };
  }

  if (label === undefined) {
    return { refused: REFUSAL.NO_LABEL };
  }

  const trimmed = label.trim();

  if (trimmed.length < MINIMUM_LABEL) {
    return { refused: REFUSAL.LABEL_TOO_SHORT };
  }

  if (actorId !== undefined) {
    // `Number` rather than `parseInt`, which reads "7abc" as 7 and would let a
    // typo address a different actor than the one the operator meant.
    const parsed = Number(actorId);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { refused: REFUSAL.ACTOR_NOT_AN_ID };
    }

    return { label: trimmed, actor: { existing: parsed } };
  }

  const kind = created?.kind ?? "";

  if (!KINDS.includes(kind)) {
    return { refused: REFUSAL.UNKNOWN_ACTOR_KIND };
  }

  const displayName = (created?.displayName ?? "").trim();

  if (displayName.length < MINIMUM_LABEL) {
    return { refused: REFUSAL.LABEL_TOO_SHORT };
  }

  return { label: trimmed, actor: { create: { kind: kind as ActorKind, displayName } } };
}
