import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  /** Maximum number of pooled connections. */
  maxConnections?: number;
}

/**
 * Creates a Drizzle client over a postgres.js connection pool.
 * Callers own the lifecycle: create once per process, never per request.
 */
export function createDatabase(
  url: string,
  options: DatabaseOptions = {},
): ReturnType<typeof drizzle<typeof schema>> {
  const client = postgres(url, { max: options.maxConnections ?? 10 });
  return drizzle(client, { schema });
}
