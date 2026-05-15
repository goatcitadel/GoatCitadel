import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupRetentionService, restoreBackupOffline, verifyBackupOffline } from "./backup-retention-service.js";
import type { GatewayRuntimeConfig } from "../config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("BackupRetentionService", () => {
  it("creates, lists, verifies, and restores a SQLite backup with contract coverage", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const storage = createStorageMock();
    const service = new BackupRetentionService({
      storage,
      config: createConfig(rootDir),
    });

    const created = await service.createBackup({ name: " Nightly Runtime Snapshot!! " });

    expect(created.backupId).toBe("nightly-runtime-snapshot");
    expect(created.outputPath).toBe(path.join(backupDir, "nightly-runtime-snapshot.backup"));
    expect(storage.gatewaySql.exec).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
    expect(created.manifest.contractCoverage.minimumSet).toMatchObject({
      databasePaths: ["data/index.db"],
      transcriptPaths: ["data/transcripts/session.jsonl"],
      auditPaths: ["data/audit/events.jsonl"],
      configPaths: ["config/assistant.config.json"],
    });

    await expect(service.listBackups()).resolves.toMatchObject([
      {
        backupId: "nightly-runtime-snapshot",
      },
    ]);
    await expect(service.verifyBackup({ filePath: created.outputPath })).resolves.toMatchObject({
      verified: true,
      contractVerified: true,
      filesVerified: 4,
      issues: [],
    });

    const restoreRoot = await makeTempDir("gc-restore-");
    const restored = await restoreBackupOffline({
      rootDir: restoreRoot,
      filePath: created.outputPath,
      confirm: true,
      backupDir,
    });

    expect(restored).toEqual({
      restored: true,
      backupId: "nightly-runtime-snapshot",
      filesRestored: 4,
    });
    await expect(fs.readFile(path.join(restoreRoot, "data", "transcripts", "session.jsonl"), "utf8")).resolves.toBe(
      '{"event":"hello"}\n',
    );
  });

  it("normalizes retention policy values and prunes only when dryRun is disabled", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const storage = createStorageMock({
      systemSetting: {
        realtimeEventsDays: 2,
        backupsKeep: 1,
        transcriptsDays: 1,
        auditDays: 1,
      },
      realtimeCount: 3,
    });
    const service = new BackupRetentionService({
      storage,
      config: createConfig(rootDir),
    });

    const oldBackup = path.join(backupDir, "old.backup");
    const newBackup = path.join(backupDir, "new.backup");
    await fs.writeFile(oldBackup, "old", "utf8");
    await fs.writeFile(newBackup, "new", "utf8");
    await setAge(oldBackup, 20);
    await setAge(newBackup, 0);
    const oldTranscript = path.join(rootDir, "data", "transcripts", "old.jsonl");
    const oldAudit = path.join(rootDir, "data", "audit", "old.jsonl");
    await fs.writeFile(oldTranscript, "old transcript", "utf8");
    await fs.writeFile(oldAudit, "old audit", "utf8");
    await setAge(oldTranscript, 20);
    await setAge(oldAudit, 20);

    expect(service.updateRetentionPolicy({ realtimeEventsDays: 9999, backupsKeep: -5, transcriptsDays: 0 })).toEqual({
      realtimeEventsDays: 365,
      backupsKeep: 1,
      transcriptsDays: 1,
      auditDays: 1,
    });

    const dryRun = await service.pruneRetention({ dryRun: true });
    expect(dryRun).toMatchObject({
      applied: false,
      removedRealtimeEvents: 3,
      removedBackupFiles: 1,
      removedTranscriptFiles: 1,
      removedAuditFiles: 1,
    });
    await expect(fs.stat(oldBackup)).resolves.toBeDefined();
    expect(storage.realtimeEvents.pruneOlderThan).not.toHaveBeenCalled();

    const applied = await service.pruneRetention({ dryRun: false });
    expect(applied).toMatchObject({
      applied: true,
      removedRealtimeEvents: 3,
      removedBackupFiles: 1,
      removedTranscriptFiles: 1,
      removedAuditFiles: 1,
    });
    await expect(fs.stat(oldBackup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldTranscript)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldAudit)).rejects.toMatchObject({ code: "ENOENT" });
    expect(storage.realtimeEvents.pruneOlderThan).toHaveBeenCalledTimes(1);
  });

  it("keeps backup paths jailed and reports manifest failures through offline verification", async () => {
    const backupDir = await makeTempDir("gc-backups-");
    const brokenBackup = path.join(backupDir, "broken.backup");
    await fs.mkdir(brokenBackup, { recursive: true });

    await expect(verifyBackupOffline({ filePath: "../outside.backup", backupDir })).rejects.toThrow(
      "Backup file path must stay within the GoatCitadel backup directory.",
    );
    await expect(
      restoreBackupOffline({ rootDir: backupDir, filePath: brokenBackup, backupDir, confirm: false }),
    ).rejects.toThrow("Backup restore requires explicit confirm=true");
    await expect(
      restoreBackupOffline({ rootDir: backupDir, filePath: brokenBackup, backupDir, confirm: true }),
    ).rejects.toThrow("manifest_missing");
  });
});

async function createRuntimeFixture(): Promise<string> {
  const rootDir = await makeTempDir("gc-runtime-");
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
  return rootDir;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
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
        postgres: {
          mode: "external",
        },
        bundledPostgres: {},
      },
    },
  } as GatewayRuntimeConfig;
}

function createStorageMock(options?: { systemSetting?: unknown; realtimeCount?: number }) {
  let stored = options?.systemSetting;
  return {
    gatewaySql: {
      exec: vi.fn(),
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ count: options?.realtimeCount ?? 0 })),
      })),
    },
    systemSettings: {
      get: vi.fn(() => (stored === undefined ? undefined : { value: stored })),
      set: vi.fn((_key: string, value: unknown) => {
        stored = value;
      }),
    },
    realtimeEvents: {
      pruneOlderThan: vi.fn(),
    },
  } as never;
}

async function setAge(filePath: string, daysAgo: number): Promise<void> {
  const epochSeconds = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(filePath, epochSeconds, epochSeconds);
}
