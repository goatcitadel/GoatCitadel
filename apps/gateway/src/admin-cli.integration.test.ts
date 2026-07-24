import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlmStatusLines, runDatabaseCommand } from "./admin-cli.js";

const execAsync = promisify(exec);
const TEMP_ROOTS: string[] = [];
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

afterEach(async () => {
  vi.restoreAllMocks();
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("admin CLI llm status formatting", () => {
  it("renders the active model contextWindow and output limit when the runtime config exposes them", () => {
    const lines = buildLlmStatusLines({
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.5",
      providers: [],
      activeModelContextWindow: 272_000,
      activeModelOutputTokenLimit: 32_000,
    });
    const joined = lines.join("\n");
    expect(joined).toMatch(/Active provider:\s+openai-codex/);
    expect(joined).toMatch(/Active model:\s+gpt-5\.5/);
    expect(joined).toMatch(/Context window:\s+272,000/);
    expect(joined).toMatch(/Output limit:\s+32,000/);
  });

  it("omits the context window and output limit when the active model has no metadata", () => {
    const lines = buildLlmStatusLines({
      activeProviderId: "custom",
      activeModel: "unknown-model",
      providers: [],
    });
    const joined = lines.join("\n");
    expect(joined).toMatch(/Active provider:\s+custom/);
    expect(joined).toMatch(/Active model:\s+unknown-model/);
    expect(joined).not.toMatch(/Context window:/);
    expect(joined).not.toMatch(/Output limit:/);
  });
});

describe("admin CLI database cutover revision handoff", () => {
  it("reads the current revision immediately before an execute request", async () => {
    const readSettingsRevision = vi.fn(() => 9);
    const runDatabaseCutover = vi.fn(async () => ({ status: "completed" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runDatabaseCommand({ readSettingsRevision, runDatabaseCutover } as never, "cutover", [
      "--profile",
      "local",
      "--execute",
      "--confirm",
    ]);

    expect(readSettingsRevision).toHaveBeenCalledOnce();
    expect(runDatabaseCutover).toHaveBeenCalledWith({
      profile: "local",
      execute: true,
      confirm: true,
      expectedRevision: 9,
    });
    expect(readSettingsRevision.mock.invocationCallOrder[0]).toBeLessThan(
      runDatabaseCutover.mock.invocationCallOrder[0]!,
    );
    expect(log).toHaveBeenCalled();
  });

  it("keeps dry runs generation-free", async () => {
    const readSettingsRevision = vi.fn(() => 9);
    const runDatabaseCutover = vi.fn(async () => ({ status: "ready" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runDatabaseCommand({ readSettingsRevision, runDatabaseCutover } as never, "cutover", [
      "--profile",
      "hosted",
      "--dry-run",
    ]);

    expect(readSettingsRevision).not.toHaveBeenCalled();
    expect(runDatabaseCutover).toHaveBeenCalledWith({
      profile: "hosted",
      execute: false,
      confirm: false,
    });
  });
});

describe("admin CLI offline backup commands", () => {
  it("verifies a backup without requiring the current runtime config to parse", async () => {
    const { runtimeRoot, backupDir } = await createOfflineBackupFixture();
    const result = await runCli(["backup", "verify", "--file", "fixture.backup"], {
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GOATCITADEL_BACKUP_DIR: backupDir,
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.verified).toBe(true);
    expect(parsed.contractVerified).toBe(true);
  }, 45_000);

  it("restores a backup without loading the current runtime config", async () => {
    const { runtimeRoot, backupDir, expected } = await createOfflineBackupFixture();
    await writeFile(path.join(runtimeRoot, "config", "llm-providers.json"), "{ invalid json", "utf8");
    await rm(path.join(runtimeRoot, "data", "index.db"), { force: true });

    await runCli(["backup", "restore", "--file", "fixture.backup", "--confirm"], {
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GOATCITADEL_BACKUP_DIR: backupDir,
    });

    expect(await readFile(path.join(runtimeRoot, "data", "index.db"))).toEqual(expected.database);
    expect(await readFile(path.join(runtimeRoot, "config", "llm-providers.json"), "utf8")).toBe(expected.config);
  }, 45_000);
});

async function createOfflineBackupFixture(): Promise<{
  runtimeRoot: string;
  backupDir: string;
  expected: {
    database: Buffer;
    transcript: string;
    audit: string;
    config: string;
  };
}> {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-admin-cli-runtime-"));
  TEMP_ROOTS.push(runtimeRoot);
  const backupDir = path.join(runtimeRoot, ".GoatCitadel", "backups");
  const backupPath = path.join(backupDir, "fixture.backup");
  const payloadRoot = path.join(backupPath, "payload");
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await mkdir(path.join(payloadRoot, "data", "transcripts"), { recursive: true });
  await mkdir(path.join(payloadRoot, "data", "audit"), { recursive: true });
  await mkdir(path.join(payloadRoot, "config"), { recursive: true });

  const expected = {
    database: await createSqliteDatabaseBytes(runtimeRoot),
    transcript: '{"event":"transcript"}\n',
    audit: '{"event":"audit"}\n',
    config: '{"providers":[{"providerId":"openai"}]}\n',
  };
  const payloadEntries = [
    { path: "data/index.db", raw: expected.database },
    { path: "data/transcripts/session.jsonl", raw: expected.transcript },
    { path: "data/audit/runtime.jsonl", raw: expected.audit },
    { path: "config/llm-providers.json", raw: expected.config },
  ];

  for (const entry of payloadEntries) {
    const fullPath = path.join(payloadRoot, entry.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, entry.raw);
  }

  const manifest = {
    backupId: "fixture",
    createdAt: "2026-04-11T00:00:00.000Z",
    appVersion: "1.0.0",
    rootDir: runtimeRoot,
    files: payloadEntries.map((entry) => ({
      path: entry.path,
      sizeBytes: Buffer.byteLength(entry.raw, "utf8"),
      sha256: createHash("sha256").update(entry.raw).digest("hex"),
    })),
    contractCoverage: {
      contractVersion: "1.0",
      minimumSet: {
        databasePaths: ["data/index.db"],
        transcriptPaths: ["data/transcripts/session.jsonl"],
        auditPaths: ["data/audit/runtime.jsonl"],
        configPaths: ["config/llm-providers.json"],
      },
    },
  };
  await writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(runtimeRoot, "config", "llm-providers.json"), "{ definitely invalid", "utf8");

  return {
    runtimeRoot,
    backupDir,
    expected,
  };
}

async function createSqliteDatabaseBytes(rootDir: string): Promise<Buffer> {
  const databasePath = path.join(rootDir, "fixture-source.db");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("CREATE TABLE backup_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    db.exec("INSERT INTO backup_fixture (value) VALUES ('restored sqlite bytes');");
  } finally {
    db.close();
  }
  const bytes = await readFile(databasePath);
  await rm(databasePath, { force: true });
  return bytes;
}

async function runCli(args: string[], env: Record<string, string>) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const escapedArgs = ["exec", "tsx", "apps/gateway/src/admin-cli.ts", ...args]
    .map((part) => `"${part.replaceAll('"', '\\"')}"`)
    .join(" ");
  return execAsync(`${command} ${escapedArgs}`, {
    cwd: repoRoot,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    env: {
      ...process.env,
      ...env,
    },
  });
}
