import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { LOCAL_DEV_PASSWORDS, localDevUrls, mayUseLocalDevPasswords } from "./local-dev.js";

/**
 * What `docker compose ps --format json` says when this project's own container
 * holds the port these URLs use.
 *
 * **Pinned against the installed Compose rather than its documentation**, which
 * is what #178 asked for: v5.3.0 prints one object per line, not an array.
 */
const OURS = JSON.stringify({
  Service: "postgres",
  State: "running",
  Publishers: [{ URL: "0.0.0.0", TargetPort: 5432, PublishedPort: 5433, Protocol: "tcp" }],
});

/**
 * The guard that decides whether a known password may be written onto a role.
 *
 * Being wrong here is not a failed test run, it is a published credential on a
 * database somebody cares about. So the cases below are written as attempts to
 * get through rather than as a description of what the function does.
 */
describe("whether a run may use the published development passwords", () => {
  const local = "postgres://trustpass:trustpass_local_dev@localhost:5433/trustpass";

  describe("both conditions are required, and neither is enough", () => {
    it("allows it when the operator asks and the host is this machine", () => {
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: local, composePs: OURS }),
      ).toEqual({
        ok: true,
      });
    });

    it("refuses a local host when nobody asked", () => {
      // The default, and the behaviour that existed before this file. A script
      // that quietly used development passwords because the host looked local
      // would be the inference this whole design exists to avoid.
      expect(
        mayUseLocalDevPasswords({ requested: false, databaseUrl: local, composePs: OURS }),
      ).toEqual({
        ok: false,
        reason: "not_requested",
      });
    });

    it("refuses a remote host even when the operator asks", () => {
      expect(
        mayUseLocalDevPasswords({
          requested: true,
          databaseUrl: "postgres://trustpass:x@db.production.example.com:5432/trustpass",
          composePs: OURS,
        }),
      ).toEqual({ ok: false, reason: "not_a_local_host" });
    });
  });

  describe("the ways a host can look local and not be", () => {
    // Each of these passes a naive check. They are the reason the set is
    // matched exactly and the reason a URL parser is used rather than a
    // pattern.
    it.each([
      [
        "localhost as the username, someone else's host",
        "postgres://localhost@db.example.com:5432/trustpass",
      ],
      ["localhost as the password", "postgres://trustpass:localhost@db.example.com:5432/trustpass"],
      [
        "a subdomain somebody else owns",
        "postgres://trustpass:x@localhost.example.com:5432/trustpass",
      ],
      [
        "a suffix somebody else owns",
        "postgres://trustpass:x@evil-localhost.example.com:5432/trustpass",
      ],
      ["localhost in the database name", "postgres://trustpass:x@db.example.com:5432/localhost"],
      [
        "localhost in a query parameter",
        "postgres://trustpass:x@db.example.com:5432/trustpass?host=localhost",
      ],
      [
        "a host that merely resolves to the loopback",
        "postgres://trustpass:x@localtest.me:5432/trustpass",
      ],
    ])("refuses %s", (_name, databaseUrl) => {
      expect(mayUseLocalDevPasswords({ requested: true, databaseUrl, composePs: OURS })).toEqual({
        ok: false,
        reason: "not_a_local_host",
      });
    });
  });

  describe("the loopback spellings that are allowed", () => {
    it.each([
      ["localhost", "postgres://trustpass:x@localhost:5433/trustpass"],
      ["127.0.0.1", "postgres://trustpass:x@127.0.0.1:5433/trustpass"],
      ["::1", "postgres://trustpass:x@[::1]:5433/trustpass"],
    ])("allows %s", (_name, databaseUrl) => {
      expect(mayUseLocalDevPasswords({ requested: true, databaseUrl, composePs: OURS })).toEqual({
        ok: true,
      });
    });
  });

  describe("when there is nothing to check", () => {
    it("refuses with no DATABASE_URL, because the host is half the decision", () => {
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: undefined, composePs: OURS }),
      ).toEqual({
        ok: false,
        reason: "no_database_url",
      });
    });

    it("refuses an empty DATABASE_URL rather than reading it as absent", () => {
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: "   ", composePs: OURS }),
      ).toEqual({
        ok: false,
        reason: "no_database_url",
      });
    });

    it("refuses something that is not a URL", () => {
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: "localhost", composePs: OURS }),
      ).toEqual({
        ok: false,
        reason: "unreadable_database_url",
      });
    });
  });

  describe("the passwords themselves", () => {
    it("says what they are in their own value", () => {
      // They are printed, logged and committed. Somebody finding one in a
      // connection string in a log should be able to tell immediately that it
      // is not a leak — and somebody finding one in production should be able
      // to tell immediately that it is a serious problem.
      for (const password of Object.values(LOCAL_DEV_PASSWORDS)) {
        expect(password).toContain("local_dev");
        expect(password).toContain("not_a_secret");
      }
    });

    it("gives each role its own, so one leaking is not both", () => {
      const values = Object.values(LOCAL_DEV_PASSWORDS);

      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe("the URLs, and the file they have to agree with", () => {
    const compose = readFileSync(
      new URL("../../../../docker-compose.yml", import.meta.url),
      "utf8",
    );

    /** `${POSTGRES_PORT:-5433}` -> `5433`. */
    function composeDefault(variable: string): string {
      const match = compose.match(new RegExp(`\\$\\{${variable}:-([^}]+)\\}`));

      if (!match?.[1]) {
        throw new Error(`docker-compose.yml declares no default for ${variable}`);
      }

      return match[1];
    }

    it("builds the superuser URL entirely from docker-compose.yml's defaults", () => {
      // The duplication named in `localDevUrls`, made into a failure instead of
      // a comment. Change a default in the compose file and this goes red
      // rather than `pnpm db:setup` handing out a URL to the wrong port — which
      // would present as "the database is not running" and send somebody to
      // look at Docker.
      //
      // Whole-string equality, not `toContain` on each part. Four substring
      // checks pass when a port appears inside a password, when the user and
      // the database name are the same word — which here they are, both
      // `trustpass` — and when the pieces are assembled in the wrong order.
      // This asserts the URL, which is the thing that is handed out.
      const expected =
        `postgres://${composeDefault("POSTGRES_USER")}:${composeDefault("POSTGRES_PASSWORD")}` +
        `@localhost:${composeDefault("POSTGRES_PORT")}/${composeDefault("POSTGRES_DB")}`;

      expect(localDevUrls({}).superuser).toBe(expected);
    });

    it("builds a superuser URL that the local-dev guard accepts", () => {
      // The two halves of this file have to agree: a URL it generates must be
      // one it would allow. They are separate functions and nothing else makes
      // them consistent.
      expect(
        mayUseLocalDevPasswords({
          requested: true,
          databaseUrl: localDevUrls({}).superuser,
          composePs: OURS,
        }),
      ).toEqual({ ok: true });
    });

    it("names a different role in each URL", () => {
      const urls = localDevUrls({});

      expect(urls.migration).toContain("trustpass_migration");
      expect(urls.runtime).toContain("trustpass_runtime");
      expect(urls.migration).not.toBe(urls.runtime);
    });

    it("follows the environment when compose would have", () => {
      // `docker compose up` with POSTGRES_PORT set publishes on that port, so a
      // URL built from the defaults would point at nothing.
      const urls = localDevUrls({ POSTGRES_PORT: "6000", POSTGRES_DB: "other" });

      expect(urls.runtime).toBe(
        `postgres://trustpass_runtime:${LOCAL_DEV_PASSWORDS.trustpass_runtime}@localhost:6000/other`,
      );
    });
  });

  describe("the condition a tunnel cannot satisfy", () => {
    // #178. `ssh -L 5433:prod-db.internal:5432 bastion` makes every hostname
    // test in the world say yes, because the hostname is true — it is the
    // database behind it that is somebody else's.
    const tunnelled = "postgres://trustpass:real@localhost:5433/trustpass";

    it("refuses a tunnel holding a port no container of ours publishes", () => {
      // Compose is running and publishes nothing on 5433, which is exactly what
      // a tunnel on 5433 requires: the two cannot both hold it.
      const elsewhere = JSON.stringify({
        Service: "postgres",
        State: "running",
        Publishers: [{ TargetPort: 5432, PublishedPort: 5544, Protocol: "tcp" }],
      });

      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: tunnelled, composePs: elsewhere }),
      ).toEqual({ ok: false, reason: "port_not_served_by_compose" });
    });

    it("refuses when compose is up but nothing is running", () => {
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: tunnelled, composePs: "" }),
      ).toEqual({ ok: false, reason: "port_not_served_by_compose" });
    });

    it("refuses when Docker could not be asked, rather than falling back", () => {
      // The direction that matters. `--local-dev` exists for the compose
      // database, so a machine that cannot say whether compose is running is not
      // one to write a published password on. Falling back to the host check
      // would restore exactly the hole this closes.
      expect(
        mayUseLocalDevPasswords({ requested: true, databaseUrl: tunnelled, composePs: null }),
      ).toEqual({ ok: false, reason: "compose_unreadable" });
    });

    it("allows the ordinary case, where our own container holds the port", () => {
      expect(
        mayUseLocalDevPasswords({
          requested: true,
          databaseUrl: "postgres://trustpass:trustpass_local_dev@localhost:5433/trustpass",
          composePs: OURS,
        }),
      ).toEqual({ ok: true });
    });

    it("reads the port out of the URL rather than assuming the default", () => {
      // A second throwaway on another port is the ordinary reason to pass a URL
      // at all, and defaulting to 5432 here would refuse it while accepting a
      // tunnel on 5432.
      const other = JSON.stringify({
        State: "running",
        Publishers: [{ TargetPort: 5432, PublishedPort: 5439, Protocol: "tcp" }],
      });

      expect(
        mayUseLocalDevPasswords({
          requested: true,
          databaseUrl: "postgres://trustpass:x@localhost:5439/trustpass",
          composePs: other,
        }),
      ).toEqual({ ok: true });
    });

    it("checks the flag and the host before it ever asks Docker", () => {
      // Order matters for the message somebody gets. A run with no flag should
      // say so, not complain that Docker is unreachable.
      expect(
        mayUseLocalDevPasswords({ requested: false, databaseUrl: tunnelled, composePs: null }),
      ).toEqual({ ok: false, reason: "not_requested" });

      expect(
        mayUseLocalDevPasswords({
          requested: true,
          databaseUrl: "postgres://trustpass:x@db.example.com:5433/trustpass",
          composePs: null,
        }),
      ).toEqual({ ok: false, reason: "not_a_local_host" });
    });
  });
});
