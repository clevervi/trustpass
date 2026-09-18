/**
 * Running Postgres' own client tools, from a machine that does not have them.
 *
 * `pg_dump` is not on PATH here, and installing it would not be enough anyway:
 * a client older than the server refuses to dump at all, so "whatever the
 * runner happens to ship" is a version mismatch waiting to break a backup on
 * the day it matters. The tools that ship *inside* the server's own image are
 * the ones guaranteed to match it, so the drill reaches for those.
 *
 * One mechanism, not three. A fallback chain would work on more machines and
 * would mean the procedure an operator rehearses is not the procedure that runs
 * in a real recovery.
 */
import { execFileSync, spawnSync } from "node:child_process";

export interface Cluster {
  /** The container running Postgres. */
  container: string;
  /** The superuser to connect as, inside it. */
  user: string;
}

export function cluster(): Cluster {
  return {
    container: process.env.TP_PG_CONTAINER || "trustpass-postgres",
    user: process.env.TP_PG_SUPERUSER || "trustpass",
  };
}

/** Whether the container is there at all, answered before anything depends on it. */
export function clusterIsReachable({ container }: Cluster): boolean {
  const probe = spawnSync("docker", ["exec", container, "true"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Runs a tool inside the container and returns its stdout as text.
 *
 * `maxBuffer` is raised because a dump of this database is already several
 * megabytes and Node's default of 1MB would truncate it into a file that looks
 * like a backup and restores into half a database.
 */
export function run(
  { container }: Cluster,
  command: readonly string[],
  input?: Buffer,
): { stdout: Buffer; stderr: string; ok: boolean } {
  const result = spawnSync("docker", ["exec", "-i", container, ...command], {
    input,
    maxBuffer: 256 * 1024 * 1024,
  });

  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    ok: result.status === 0,
  };
}

/** A single query, answered as text. Throws on failure, because callers assert on the answer. */
export function query(c: Cluster, database: string, sql: string): string {
  const result = run(c, ["psql", "-U", c.user, "-d", database, "-tAqc", sql]);

  if (!result.ok) {
    throw new Error(`Query failed against ${database}: ${result.stderr.trim()}`);
  }

  return result.stdout.toString("utf8").trim();
}

/** For the handful of places a failure is an expected outcome rather than a fault. */
export function tryQuery(c: Cluster, database: string, sql: string): string | null {
  const result = run(c, ["psql", "-U", c.user, "-d", database, "-tAqc", sql]);
  return result.ok ? result.stdout.toString("utf8").trim() : null;
}

/**
 * Puts a file inside the container.
 *
 * Not a pipe. A custom-format dump is read by seeking around its table of
 * contents, and `/dev/stdin` fed from a pipe cannot seek — measured, and it
 * surfaces as `did not find magic string in file header`, which reads like a
 * corrupt backup and is not one. Copying the file in is also what a real
 * recovery does: somebody has a file, and restores it.
 */
export function copyIn(
  { container }: Cluster,
  localPath: string,
  containerPath: string,
): { ok: boolean; stderr: string } {
  const result = spawnSync("docker", ["cp", localPath, `${container}:${containerPath}`]);
  return { ok: result.status === 0, stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8") };
}

export function dockerVersion(): string {
  try {
    return execFileSync("docker", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "docker not available";
  }
}
