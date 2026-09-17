import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/**
 * Round-trips a trivial query to prove the connection pool is usable.
 * Returns false instead of throwing so callers can report degraded health.
 */
export async function isDatabaseReachable(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
