/**
 * Reading Compose's answer, without Docker.
 *
 * The `Mutations` workflow has no Docker and no Postgres, so everything that
 * decides lives in a pure function over the text Compose printed. The shape of
 * that text is the part #178 warned about — it has changed between Compose
 * versions — so the fixture below is **measured against the installed one**
 * rather than copied from documentation.
 */
import { describe, expect, it } from "vitest";
import { publishedPorts, servesPort } from "./compose-port.js";

/**
 * Verbatim from `docker compose ps --format json` on Compose **v5.3.0**, with
 * the fields this rule reads. One object per line, not an array.
 */
const MEASURED = JSON.stringify({
  Service: "postgres",
  State: "running",
  Name: "trustpass-postgres",
  Publishers: [
    { URL: "0.0.0.0", TargetPort: 5432, PublishedPort: 5433, Protocol: "tcp" },
    { URL: "::", TargetPort: 5432, PublishedPort: 5433, Protocol: "tcp" },
  ],
});

describe("what this project's compose services publish", () => {
  it("reads the shape the installed Compose actually prints", () => {
    expect(publishedPorts(MEASURED)).toEqual([5433, 5433]);
  });

  it("reads several services, one object per line", () => {
    const second = JSON.stringify({
      Service: "redis",
      State: "running",
      Publishers: [{ TargetPort: 6379, PublishedPort: 6380, Protocol: "tcp" }],
    });

    expect(publishedPorts(`${MEASURED}\n${second}`)).toContain(6380);
  });

  it("reads an array too, which older Compose printed", () => {
    // Not measured — this version does not produce it. Accepted because the
    // cost is three lines and the failure mode is refusing a legitimate run.
    expect(publishedPorts(`[${MEASURED}]`)).toEqual([5433, 5433]);
  });

  it("ignores a service that is not running, whose port a tunnel is free to take", () => {
    const stopped = MEASURED.replace('"State":"running"', '"State":"exited"');

    expect(publishedPorts(stopped)).toEqual([]);
  });

  it("ignores a publisher that is not tcp", () => {
    const udp = JSON.stringify({
      State: "running",
      Publishers: [{ PublishedPort: 5433, Protocol: "udp" }],
    });

    expect(publishedPorts(udp)).toEqual([]);
  });

  it("ignores a port Compose reports as zero, which is not one anybody can reach", () => {
    const unpublished = JSON.stringify({
      State: "running",
      Publishers: [{ TargetPort: 5432, PublishedPort: 0, Protocol: "tcp" }],
    });

    expect(publishedPorts(unpublished)).toEqual([]);
  });

  it("answers nothing for no output and for output it cannot read", () => {
    // Compose printing nothing is the ordinary "no services" case; garbage is
    // what a version change looks like. Both have to mean "no evidence", never
    // "no restriction" — the caller refuses on an empty answer.
    expect(publishedPorts("")).toEqual([]);
    expect(publishedPorts("   ")).toEqual([]);
    expect(publishedPorts("not json at all")).toEqual([]);
  });

  it("skips a line it cannot read and keeps the ones it can", () => {
    expect(publishedPorts(`oops\n${MEASURED}`)).toEqual([5433, 5433]);
  });
});

describe("whether a port is ours", () => {
  it("says yes for the port the container publishes", () => {
    expect(servesPort(MEASURED, 5433)).toBe(true);
  });

  it("says no for a port nothing of ours publishes, which is the tunnel", () => {
    // The whole point. `ssh -L 5555:prod:5432` gives a `localhost` hostname and
    // a port no container of ours holds.
    expect(servesPort(MEASURED, 5555)).toBe(false);
  });

  it("says no for the container's own internal port, which is not published", () => {
    // 5432 is `TargetPort`, reachable inside the network and not from here.
    // Reading the wrong field would accept a tunnel on 5432 exactly.
    expect(servesPort(MEASURED, 5432)).toBe(false);
  });

  it("says no when Compose said nothing", () => {
    expect(servesPort("", 5433)).toBe(false);
  });
});
