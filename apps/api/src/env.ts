import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL must not be empty"),

  /**
   * Starts against a database connection that can dismantle its own guarantees.
   *
   * Deliberately not keyed on NODE_ENV. That field carries
   * `.default("development")` two lines up, so a deploy that forgot to set it —
   * the same forgetfulness the check exists to catch — would disarm the check
   * instead of triggering it. An explicit opt-in inverts that: forgetting any
   * variable now makes the process stricter.
   *
   * Only the literal "true" enables it. `z.coerce.boolean()` would read
   * "false", "0" and "no" as true, which is the wrong way for this one to be
   * wrong.
   */
  TRUSTPASS_ALLOW_PRIVILEGED_DATABASE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates process configuration once, at boot.
 *
 * Failing here is intentional: a service that starts with a missing or
 * malformed DATABASE_URL only fails later, under traffic, with a worse error.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
