import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  classify,
  decideRoute,
  loadPolicy,
  resolveReal,
  S0,
  S1,
  S2,
  S3,
} from "../scripts/tp-router.mjs";

let root;

const OK_POLICY = { ok: true, reason: null, patterns: [] };

function write(relativePath, contents = "x\n") {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A file big enough that the router would consider replacing it with a map. */
function writeLarge(relativePath) {
  return write(relativePath, `${"const x = 1;\n".repeat(900)}`);
}

function sizeOf(path) {
  const contents = readFileSync(path, "utf8");
  return { bytes: Buffer.byteLength(contents), lines: contents.split("\n").length };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "tp-router-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("classify", () => {
  it("never transmits a .env, whatever the policy file says", () => {
    const path = write(".env", "SECRET=1\n");
    const { level } = classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY });

    // The policy file is empty and permissive here on purpose: S0 does not
    // consult it, which is the entire reason S0 exists in code.
    assert.equal(level, S0);
  });

  it("never transmits private key material", () => {
    for (const name of ["deploy.pem", "server.key", "bundle.p12", "cert.pfx"]) {
      const path = write(name);
      assert.equal(
        classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY }).level,
        S0,
        name,
      );
    }
  });

  it("refuses a file outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "tp-outside-"));
    const path = join(outside, "notes.md");
    writeFileSync(path, "x\n", "utf8");

    try {
      const { level, reason } = classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY });
      assert.equal(level, S0);
      assert.match(reason, /outside the repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps migrations and ADRs for Claude", () => {
    for (const name of [
      "packages/db/drizzle/0024_three_roles.sql",
      "docs/adr/0013-something.md",
      "packages/db/src/schema/product.ts",
      "apps/api/src/auth/session.ts",
    ]) {
      const path = write(name);
      assert.equal(
        classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY }).level,
        S1,
        name,
      );
    }
  });

  it("treats bulk files as the ones worth delegating", () => {
    const path = write("apps/api/src/routes/products.test.ts");
    assert.equal(classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY }).level, S3);
  });

  it("treats ordinary source as a candidate", () => {
    const path = write("apps/web/app/page.tsx");
    assert.equal(classify(resolveReal(path), { repoRoot: root, policy: OK_POLICY }).level, S2);
  });

  it("follows a symlink before deciding, so a safe name cannot borrow a secret", (t) => {
    const secret = write(".env.production", "TOKEN=live\n");
    const link = join(root, "docs", "harmless.md");
    mkdirSync(join(root, "docs"), { recursive: true });

    try {
      symlinkSync(secret, link, "file");
    } catch (error) {
      // Windows refuses file symlinks without Developer Mode or elevation.
      // Skipping is honest; passing quietly would be a test that reports a
      // guarantee it never checked.
      return t.skip(`this platform will not create a file symlink: ${error.code}`);
    }

    const { level } = classify(resolveReal(link), { repoRoot: root, policy: OK_POLICY });

    // Classified by what it IS, not by what it is called.
    assert.equal(level, S0);
  });

  it("falls closed when the policy file cannot be trusted", () => {
    const path = write("apps/web/app/page.tsx");
    const broken = {
      ok: false,
      reason: "sensitive-paths.txt is missing or unreadable",
      patterns: [],
    };

    const { level, reason } = classify(resolveReal(path), { repoRoot: root, policy: broken });

    // Not S2. A policy that cannot be read is not a permissive policy — and
    // Claude still reads the file, so the cost of being wrong this way is zero.
    assert.equal(level, S1);
    assert.match(reason, /missing or unreadable/);
  });

  it("lets the policy file add a rule", () => {
    const path = write("apps/api/src/routes/passports.ts");
    const policy = { ok: true, reason: null, patterns: ["routes/passports"] };

    assert.equal(classify(resolveReal(path), { repoRoot: root, policy }).level, S1);
  });
});

describe("loadPolicy", () => {
  it("fails closed when the file is absent", () => {
    const policy = loadPolicy(() => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    }, "/nowhere");

    assert.equal(policy.ok, false);
    assert.deepEqual(policy.patterns, []);
  });

  it("ignores comments and blank lines", () => {
    const policy = loadPolicy(() => "# a comment\n\n  docs/legal/  \n", "/anywhere");

    assert.equal(policy.ok, true);
    assert.deepEqual(policy.patterns, ["docs/legal/"]);
  });
});

describe("decideRoute", () => {
  it("leaves a bounded read alone, which is how verification stays possible", () => {
    const path = writeLarge("apps/web/big.tsx");
    const decision = decideRoute(
      { toolName: "Read", filePath: path, offset: 400, limit: 60 },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "passthrough");
    assert.match(decision.reason, /bounded read/);
  });

  it("leaves a small file alone", () => {
    const path = write("apps/web/small.tsx", `${"const x = 1;\n".repeat(50)}`);
    const decision = decideRoute(
      { toolName: "Read", filePath: path },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "passthrough");
    assert.match(decision.reason, /small enough/);
  });

  it("delegates a large ordinary file", () => {
    const path = writeLarge("apps/web/app/huge-component.tsx");
    const decision = decideRoute(
      { toolName: "Read", filePath: path },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "delegate");
    assert.equal(decision.level, S2);
  });

  it("does not delegate a large migration", () => {
    const path = writeLarge("packages/db/drizzle/0099_enormous.sql");
    const decision = decideRoute(
      { toolName: "Read", filePath: path },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "passthrough");
    assert.match(decision.reason, /^S1/);
  });

  it("ignores tools that are not Read", () => {
    const decision = decideRoute(
      { toolName: "Bash", filePath: "/etc/passwd" },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "passthrough");
  });

  it("survives a payload with no file path at all", () => {
    const decision = decideRoute(
      { toolName: "Read" },
      { repoRoot: root, policy: OK_POLICY, sizeOf },
    );

    assert.equal(decision.action, "passthrough");
  });
});
