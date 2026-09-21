/**
 * The guard that decides whether a published password may be written onto a role.
 *
 * #178: the old version read the hostname out of `DATABASE_URL`, which is a
 * claim about where a socket goes and costs nothing to make false —
 * `ssh -L 5433:prod-db.internal:5432` satisfies every hostname test there is.
 * The condition a tunnel cannot satisfy is whether this project's own compose
 * container publishes that port, because the two cannot both hold it.
 *
 * Everything that decides is a pure function over the text Compose printed, and
 * not by preference: the `Mutations` workflow has no Docker and no Postgres, so
 * a guard reachable only through the running daemon could not be broken on
 * purpose at all.
 */
export default {
  name: "local-dev",
  issue: 178,

  protects: ["packages/db/src/scripts/local-dev.ts", "packages/db/src/scripts/compose-port.ts"],

  runner: {
    cwd: "packages/db",
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "src/scripts/local-dev.test.ts",
      "src/scripts/compose-port.test.ts",
      "--reporter=dot",
    ],
    nameFlag: "-t",
  },

  mutations: [
    {
      file: "packages/db/src/scripts/local-dev.ts",
      mutations: [
        {
          // The mutant #178 names explicitly.
          label: "the compose condition always answers that the port is ours",
          test: "refuses a tunnel holding a port no container of ours publishes",
          from: "  if (!servesPort(input.composePs, port)) {",
          to: "  if (false) {",
        },
        {
          label: "an unreachable Docker falls back to the host check instead of refusing",
          test: "refuses when Docker could not be asked, rather than falling back",
          from: '  if (input.composePs === null) {\n    return { ok: false, reason: "compose_unreadable" };\n  }',
          to: "  if (input.composePs === null) {\n    return { ok: true };\n  }",
        },
        {
          label: "the port is assumed rather than read out of the URL",
          test: "reads the port out of the URL rather than assuming the default",
          from: '  const port = Number(new URL(input.databaseUrl).port || "5432");',
          to: "  const port = 5433;",
        },
        {
          label: "the host check is dropped now that a second one exists",
          test: "refuses a remote host even when the operator asks",
          from: "  if (!LOCAL_HOSTS.has(hostname)) {",
          to: "  if (false) {",
        },
      ],
    },
    {
      file: "packages/db/src/scripts/compose-port.ts",
      mutations: [
        {
          label: "a stopped container's port counts as served",
          test: "ignores a service that is not running, whose port a tunnel is free to take",
          from: '    if (service.State !== "running") continue;',
          to: "    if (false) continue;",
        },
        {
          label: "the container's internal port is read instead of the published one",
          test: "says no for the container's own internal port, which is not published",
          from: "      const port = Number(publisher.PublishedPort);",
          to: "      const port = Number(publisher.TargetPort);",
        },
        {
          label: "a port Compose reports as zero counts as a real one",
          test: "ignores a port Compose reports as zero, which is not one anybody can reach",
          from: "      if (Number.isInteger(port) && port > 0) ports.push(port);",
          to: "      if (Number.isInteger(port)) ports.push(port);",
        },
        {
          label: "output that cannot be read is treated as an empty answer without lines",
          test: "skips a line it cannot read and keeps the ones it can",
          from: "        .flatMap((line) => {\n          try {\n            return [JSON.parse(line) as unknown];\n          } catch {\n            return [];\n          }\n        });",
          to: "        .flatMap(() => []);",
        },
      ],
    },
  ],
};
