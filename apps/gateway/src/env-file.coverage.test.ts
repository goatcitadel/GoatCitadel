import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteLocalEnvVar,
  detectEnvFilePath,
  loadLocalEnvFile,
  resolveWritableEnvFilePath,
  upsertLocalEnvVar,
} from "./env-file.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("env-file tail behavior", () => {
  it("loads escaped values, skips invalid lines, and avoids a second implicit reload", async () => {
    const root = await createRepoRoot("goatcitadel-env-tail-");
    const envPath = path.join(root, ".env");
    await fs.writeFile(
      envPath,
      [
        'TAIL_ESCAPED_VALUE="line1\\nline2\\t\\"quoted\\"\\\\slash"',
        "TAIL_SINGLE_QUOTED='literal # value'",
        "TAIL_INLINE_COMMENT=visible # hidden",
        "1_INVALID=ignored",
        "MISSING_EQUALS",
        "",
      ].join("\n"),
      "utf8",
    );

    await withTemporaryEnv(
      ["GOATCITADEL_ROOT_DIR", "TAIL_ESCAPED_VALUE", "TAIL_SINGLE_QUOTED", "TAIL_INLINE_COMMENT", "TAIL_SECOND_LOAD"],
      async () => {
        process.env.GOATCITADEL_ROOT_DIR = root;

        const first = loadLocalEnvFile({ forceReload: true });
        expect(first).toMatchObject({
          path: envPath,
          applied: expect.arrayContaining(["TAIL_ESCAPED_VALUE", "TAIL_SINGLE_QUOTED", "TAIL_INLINE_COMMENT"]),
        });
        expect(process.env.TAIL_ESCAPED_VALUE).toBe('line1\nline2\t"quoted"\\slash');
        expect(process.env.TAIL_SINGLE_QUOTED).toBe("literal # value");
        expect(process.env.TAIL_INLINE_COMMENT).toBe("visible");
        expect(process.env["1_INVALID"]).toBeUndefined();

        await fs.writeFile(envPath, "TAIL_SECOND_LOAD=should-not-apply\n", "utf8");

        expect(loadLocalEnvFile()).toEqual({ applied: [], skipped: [] });
        expect(process.env.TAIL_SECOND_LOAD).toBeUndefined();
      },
    );
  });

  it("detects writable env files from explicit roots and reports missing env files without creating them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-fallback-"));
    tempRoots.push(root);
    const envPath = path.join(root, ".env");
    const priorCwd = process.cwd();

    try {
      process.chdir(root);

      expect(detectEnvFilePath({ rootDir: root })).toBeUndefined();
      expect(resolveWritableEnvFilePath({ rootDir: root })).toBeUndefined();

      await fs.writeFile(envPath, "TAIL_EXISTING=1\n", "utf8");

      expect(resolveWritableEnvFilePath({ rootDir: root })).toBe(envPath);
      expect(detectEnvFilePath({ rootDir: root })).toBe(envPath);
    } finally {
      process.chdir(priorCwd);
    }
  });

  it("preserves comments while replacing exported keys and leaves missing deletes untouched", async () => {
    const root = await createRepoRoot("goatcitadel-env-edit-tail-");
    const envPath = path.join(root, ".env");
    await fs.writeFile(envPath, ["# keep me", "export TAIL_REPLACED=old", "TAIL_OTHER=value", ""].join("\n"), "utf8");

    const replaced = upsertLocalEnvVar(" TAIL_REPLACED ", "new\tvalue", { rootDir: root });
    const missingDelete = deleteLocalEnvVar("TAIL_MISSING", { rootDir: root });
    const raw = await fs.readFile(envPath, "utf8");

    expect(replaced).toEqual({ path: envPath, updated: true });
    expect(missingDelete).toEqual({ path: envPath, updated: false });
    expect(raw).toContain("# keep me");
    expect(raw).toContain('TAIL_REPLACED="new\\tvalue"');
    expect(raw).toContain("TAIL_OTHER=value");
  });

  it("rejects invalid keys before editing local env files", async () => {
    const root = await createRepoRoot("goatcitadel-env-invalid-key-");
    await fs.writeFile(path.join(root, ".env"), "TAIL_KEY=value\n", "utf8");

    expect(() => upsertLocalEnvVar("NOT VALID", "value", { rootDir: root })).toThrow("Invalid env var key");
    expect(() => deleteLocalEnvVar("NOT VALID", { rootDir: root })).toThrow("Invalid env var key");
  });
});

async function createRepoRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "assistant.config.json"), "{}\n", "utf8");
  return root;
}

async function withTemporaryEnv(keys: string[], callback: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
