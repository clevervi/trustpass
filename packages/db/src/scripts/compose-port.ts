/**
 * Whether a port is served by this project's own compose container.
 *
 * `--local-dev` writes published passwords, so it asks whether the database is
 * the throwaway one. It used to ask that by reading the hostname out of
 * `DATABASE_URL` — and a hostname is a claim about where a socket goes, which
 * costs nothing to make false:
 *
 * ```bash
 * ssh -L 5433:prod-db.internal:5432 bastion
 * DATABASE_URL=postgres://trustpass:<the real one>@localhost:5433/trustpass \
 *   pnpm db:provision --local-dev
 * ```
 *
 * Flag present, host `localhost`, guard satisfied, and `trustpass_runtime` on a
 * real database now holds a password published in this repository. #178.
 *
 * **The question that cannot be lied to** is not "is this host local" but "is
 * this port currently served by our container", because a tunnel and the
 * container cannot both hold it. If compose has `5433`, `ssh -L 5433:…` fails
 * to bind; if the tunnel has it, compose could not have started.
 *
 * That is a second, independent condition rather than a stronger version of the
 * first — which is the point. The flag, the host and this one all have to hold.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { docker } from "./pg-tools.js";

/**
 * The directory holding `docker-compose.yml`.
 *
 * Four levels up from `packages/db/src/scripts`, computed rather than assumed
 * from the working directory: these scripts are run from the repository root by
 * `pnpm` and from `packages/db` by hand, and `docker compose` reads the file
 * beside it.
 */
export function repositoryRoot(): string {
  return resolve(import.meta.dirname, "..", "..", "..", "..");
}

/**
 * The ports this project's compose services publish, from `ps` output.
 *
 * **Pinned against the installed Compose rather than its documentation**, which
 * is what #178 asked for: `docker compose ps --format json` on **v5.3.0** emits
 * one object per line, not an array, each carrying
 * `Publishers: [{ URL, TargetPort, PublishedPort, Protocol }]` and a `State`.
 * Older versions emitted a single array, so both are read — but only the first
 * is measured, and this comment says which.
 *
 * Only `running` services count. A stopped container publishes nothing, and its
 * port is exactly the one a tunnel is free to take.
 */
export function publishedPorts(raw: string): readonly number[] {
  const text = raw.trim();

  if (text === "") return [];

  const entries: unknown[] = (() => {
    try {
      const parsed: unknown = JSON.parse(text);

      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // The measured shape: one object per line.
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        });
    }
  })();

  const ports: number[] = [];

  for (const entry of entries) {
    const service = entry as {
      State?: unknown;
      Publishers?: { PublishedPort?: unknown; Protocol?: unknown }[] | null;
    };

    if (service.State !== "running") continue;

    for (const publisher of service.Publishers ?? []) {
      if (publisher.Protocol !== "tcp") continue;

      const port = Number(publisher.PublishedPort);

      // `0` is what Compose reports for a port it did not publish, and
      // `Number(undefined)` is NaN. Neither is a port somebody can connect to.
      if (Number.isInteger(port) && port > 0) ports.push(port);
    }
  }

  return ports;
}

/** Whether the parsed output claims that port for one of our own services. */
export function servesPort(raw: string, port: number): boolean {
  return publishedPorts(raw).includes(port);
}

/**
 * Asks Docker, from the directory holding `docker-compose.yml`.
 *
 * `null` when the question cannot be answered — Docker absent, daemon down,
 * compose failing. The caller refuses on `null`, which is the correct direction:
 * `--local-dev` exists for the compose database, and a machine that cannot say
 * whether compose is running is not one to write a published password on.
 */
export function composePsJson(projectRoot: string): string | null {
  try {
    return execFileSync(docker(), ["compose", "ps", "--format", "json"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
  } catch {
    return null;
  }
}
