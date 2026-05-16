import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupRetentionService, restoreBackupOffline } from "./backup-retention-service.js";
import type { GatewayRuntimeConfig } from "../config.js";

// Regression coverage for SECURITY_AUDIT_2026-05-15 — S8 (restored credential
// files locked to 0600 owner-only perms instead of inheriting the archive's
// default umask). World-readable .env / config/*.json on restore would leak
// OAuth tokens, API keys, signing secrets to any other user on the host.

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function createSensitiveRuntimeFixture(): Promise<string> {
  const rootDir = await makeTempDir("gc-runtime-sec-");
  await fs.mkdir(path.join(rootDir, "data", "transcripts"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "data", "audit"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "data", "index.db"), "sqlite\n", "utf8");
  await fs.writeFile(path.join(rootDir, "data", "transcripts", "session.jsonl"), '{"event":"hello"}\n', "utf8");
  await fs.writeFile(path.join(rootDir, "data", "audit", "events.jsonl"), '{"event":"audit"}\n', "utf8");
  await fs.writeFile(
    path.join(rootDir, "config", "assistant.config.json"),
    '{"database":{"driver":"sqlite"}}\n',
    "utf8",
  );
  // Write a sensitive credential file with overly permissive perms to mimic a
  // tarball-style restore that inherited 0644 from the archive.
  await fs.writeFile(path.join(rootDir, "config", "auth.json"), '{"token":"deadbeef"}\n', "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(path.join(rootDir, "config", "auth.json"), 0o644);
  }
  return rootDir;
}

function createConfig(rootDir: string): GatewayRuntimeConfig {
  return {
    rootDir,
    dbPath: path.join(rootDir, "data", "index.db"),
    assistant: {
      dataDir: "data",
      transcriptsDir: "data/transcripts",
      auditDir: "data/audit",
      database: {
        driver: "sqlite",
        postgres: { mode: "external" },
        bundledPostgres: {},
      },
    },
  } as GatewayRuntimeConfig;
}

function createStorageMock() {
  return {
    gatewaySql: {
      exec: vi.fn(),
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ count: 0 })),
      })),
    },
    systemSettings: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    },
    realtimeEvents: {
      pruneOlderThan: vi.fn(),
    },
  } as never;
}

describe("restoreBackupOffline — credential perms (S8)", () => {
  it("locks restored config/*.json files to 0600 on POSIX even when the archive contained 0644", async () => {
    if (process.platform === "win32") {
      return;
    }
    const sourceRoot = await createSensitiveRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-sec-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);

    const service = new BackupRetentionService({
      storage: createStorageMock(),
      config: createConfig(sourceRoot),
    });
    const created = await service.createBackup({ name: "sec-suite" });

    // Tamper with backup payload to leave perms world-readable, then restore.
    const payloadAuth = path.join(created.outputPath, "payload", "config", "auth.json");
    await fs.chmod(payloadAuth, 0o644);

    const restoreRoot = await makeTempDir("gc-restore-sec-");
    await restoreBackupOffline({
      rootDir: restoreRoot,
      filePath: created.outputPath,
      confirm: true,
      backupDir,
    });

    const restoredAuth = path.join(restoreRoot, "config", "auth.json");
    const info = await fs.stat(restoredAuth);
    expect(info.mode & 0o777).toBe(0o600);

    // Non-sensitive contract files are restored with default perms — no
    // need to lock them down.
    const transcriptInfo = await fs.stat(path.join(restoreRoot, "data", "transcripts", "session.jsonl"));
    expect(transcriptInfo.mode & 0o777).not.toBe(0o600);
  });

  it("leaves non-sensitive contract paths (data/*) untouched on restore", async () => {
    if (process.platform === "win32") {
      return;
    }
    const sourceRoot = await createSensitiveRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-sec2-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);

    const service = new BackupRetentionService({
      storage: createStorageMock(),
      config: createConfig(sourceRoot),
    });
    const created = await service.createBackup({ name: "sec-2" });
    const restoreRoot = await makeTempDir("gc-restore-sec2-");
    await restoreBackupOffline({
      rootDir: restoreRoot,
      filePath: created.outputPath,
      confirm: true,
      backupDir,
    });

    const audit = await fs.stat(path.join(restoreRoot, "data", "audit", "events.jsonl"));
    // Default umask leaves audit/transcript readable; that's correct — those
    // are operational logs, not credentials.
    expect(audit.mode & 0o777).not.toBe(0o600);
  });
});
