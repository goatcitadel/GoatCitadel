import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledPostgresPasswordFilePath,
  ensureBundledPostgresPassword,
  readBundledPostgresPassword,
} from "./bundled-postgres-runtime.js";

// Regression coverage for CODEX_FINDING #2: the bundled Postgres Docker
// container used `POSTGRES_HOST_AUTH_METHOD=trust` — anyone who could
// reach the published port (even just locally, post the 127.0.0.1 bind
// fix) connected as the postgres superuser without credentials. The fix:
//   1. generate a per-install random password and persist it under
//      `data/secrets/postgres-bundled-password` (mode 0600),
//   2. pass the password via a temporary Docker env file and switch
//      `POSTGRES_HOST_AUTH_METHOD` to `scram-sha-256` so fresh data dirs
//      require password auth without putting the password in docker argv,
//   3. surface the same password to `resolveGatewayPostgresConnectionOptions`
//      so the gateway itself can connect.

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const next = tempRoots.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

function makeConfig(rootDir: string) {
  return { rootDir } as never;
}

describe("ensureBundledPostgresPassword (codex #2)", () => {
  it("generates a fresh password file on first call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-secret-"));
    tempRoots.push(root);
    const password = await ensureBundledPostgresPassword(makeConfig(root));
    expect(password.length).toBeGreaterThanOrEqual(16);
    const stored = await readFile(bundledPostgresPasswordFilePath(makeConfig(root)), "utf8");
    expect(stored.trim()).toBe(password);
  });

  it("returns the existing password on subsequent calls (idempotent)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-secret-"));
    tempRoots.push(root);
    const first = await ensureBundledPostgresPassword(makeConfig(root));
    const second = await ensureBundledPostgresPassword(makeConfig(root));
    expect(second).toBe(first);
  });

  it("writes the password file with mode 0o600 on POSIX filesystems", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-secret-"));
    tempRoots.push(root);
    await ensureBundledPostgresPassword(makeConfig(root));
    const info = await stat(bundledPostgresPasswordFilePath(makeConfig(root)));
    if (process.platform !== "win32") {
      const masked = info.mode & 0o777;
      expect(masked & 0o077).toBe(0);
    }
  });

  it("readBundledPostgresPassword returns undefined when the file is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-secret-"));
    tempRoots.push(root);
    const value = await readBundledPostgresPassword(makeConfig(root));
    expect(value).toBeUndefined();
  });

  it("readBundledPostgresPassword returns undefined for a too-short stored value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-pg-secret-"));
    tempRoots.push(root);
    const filePath = bundledPostgresPasswordFilePath(makeConfig(root));
    await ensureBundledPostgresPassword(makeConfig(root));
    // Overwrite with a short value — the reader treats this as invalid.
    await (await import("node:fs/promises")).writeFile(filePath, "shortish", "utf8");
    expect(await readBundledPostgresPassword(makeConfig(root))).toBeUndefined();
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("bundled Postgres Docker spawn uses password auth (codex #2)", () => {
  const source = readFileSync(path.resolve(__dirname, "bundled-postgres-runtime.ts"), "utf8");

  it("sets POSTGRES_HOST_AUTH_METHOD=scram-sha-256 (not trust) in the docker run args", () => {
    expect(source).toMatch(/POSTGRES_HOST_AUTH_METHOD=scram-sha-256/);
    // Permit the comment / migration history to mention "trust", but the
    // ACTUAL `--env "POSTGRES_HOST_AUTH_METHOD=trust"` invocation must be gone.
    expect(source).not.toMatch(/"--env"[\s\S]{0,160}"POSTGRES_HOST_AUTH_METHOD=trust"/);
  });

  it("passes POSTGRES_PASSWORD through a temporary env file instead of docker argv", () => {
    expect(source).toMatch(/POSTGRES_PASSWORD=\$\{bundledPassword\}/);
    expect(source).toMatch(/"--env-file"/);
    expect(source).not.toMatch(/"--env"[\s\S]*`POSTGRES_PASSWORD=\$\{bundledPassword\}`/);
  });

  it("uses SHA-256 for new bundled Docker container names", () => {
    expect(source).toMatch(/createHash\("sha256"\)/);
    expect(source).not.toMatch(/createHash\("sha1"\)/);
  });

  it("binds the published port to 127.0.0.1 only", () => {
    expect(source).toMatch(/127\.0\.0\.1:\$\{config\.assistant\.database\.bundledPostgres\.port\}:5432/);
  });
});
