import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertLocalEnvVar } from "./env-file.js";

// Regression coverage for SECURITY_AUDIT_2026-05-15 — S4 (atomic credential
// writer, no TOCTOU window) + S8 (restored credential perms locked to 0600).

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

async function withTempRoot<T>(action: (rootDir: string, envPath: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-security-"));
  TEMP_ROOTS.push(rootDir);
  await mkdir(path.join(rootDir, "config"), { recursive: true });
  await writeFile(path.join(rootDir, "config", "assistant.config.json"), "{}\n", "utf8");
  const envPath = path.join(rootDir, ".env");
  const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
  try {
    process.env.GOATCITADEL_ROOT_DIR = rootDir;
    return await action(rootDir, envPath);
  } finally {
    if (priorRoot === undefined) {
      delete process.env.GOATCITADEL_ROOT_DIR;
    } else {
      process.env.GOATCITADEL_ROOT_DIR = priorRoot;
    }
  }
}

describe("upsertLocalEnvVar — credential writer security (S4 + S8)", () => {
  it("writes via tmp+rename without leaving a partial file behind", async () => {
    await withTempRoot(async (rootDir, envPath) => {
      const result = upsertLocalEnvVar("OPENAI_API_KEY", "sk-from-test");
      expect(result.updated).toBe(true);
      expect(result.path).toBe(envPath);

      const raw = await readFile(envPath, "utf8");
      expect(raw).toMatch(/^OPENAI_API_KEY="sk-from-test"/);

      // No stray *.tmp sibling left behind by the atomic-rename pattern.
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(rootDir);
      const stray = entries.filter((name) => name.includes(".tmp"));
      expect(stray).toEqual([]);
    });
  });

  it("locks the .env file to owner-only perms (0600) on POSIX", async () => {
    if (process.platform === "win32") {
      // chmod does not map to Windows ACLs; the parent directory's ACL is the
      // enforcement boundary on Windows. Covered by docker-compose cap_drop.
      return;
    }
    await withTempRoot(async (_rootDir, envPath) => {
      upsertLocalEnvVar("ANTHROPIC_API_KEY", "secret-bytes");
      const info = await stat(envPath);
      const perms = info.mode & 0o777;
      expect(perms).toBe(0o600);
    });
  });

  it("preserves 0600 perms on subsequent updates (the rename does not inherit umask)", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempRoot(async (_rootDir, envPath) => {
      upsertLocalEnvVar("FOO", "one");
      upsertLocalEnvVar("BAR", "two");
      upsertLocalEnvVar("FOO", "one-updated");
      const info = await stat(envPath);
      expect(info.mode & 0o777).toBe(0o600);
      const raw = await readFile(envPath, "utf8");
      expect(raw).toMatch(/FOO="one-updated"/);
      expect(raw).toMatch(/BAR="two"/);
    });
  });
});
