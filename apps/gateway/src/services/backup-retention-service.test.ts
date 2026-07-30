import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupRetentionService, restoreBackupOffline, verifyBackupOffline } from "./backup-retention-service.js";
import type { GatewayRuntimeConfig } from "../config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("BackupRetentionService", () => {
  it("creates, lists, verifies, and restores a SQLite backup with contract coverage", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const storage = createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") });
    const service = new BackupRetentionService({
      storage,
      config: createConfig(rootDir),
    });

    const created = await service.createBackup({ name: " Nightly Runtime Snapshot!! " });

    expect(created.backupId).toBe("nightly-runtime-snapshot");
    expect(created.outputPath).toBe(path.join(backupDir, "nightly-runtime-snapshot.backup"));
    expect(storage.createSqliteSnapshot).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]payload[\\/]data[\\/]index\.db$/),
    );
    expect(storage.gatewaySql.exec).not.toHaveBeenCalledWith(expect.stringContaining("wal_checkpoint"));
    expect(created.manifest.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining(["data/index.db-wal", "data/index.db-shm"]),
    );
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
    const publishedEntriesBeforeInspection = await fs.readdir(backupDir);
    await expect(service.inspectLatestBackupTrust()).resolves.toMatchObject({
      backupId: "nightly-runtime-snapshot",
      verified: true,
      contractVerified: true,
      issueCodes: [],
    });
    await expect(fs.readdir(backupDir)).resolves.toEqual(publishedEntriesBeforeInspection);

    await fs.writeFile(path.join(created.outputPath, "payload", "data", "transcripts", "session.jsonl"), "tampered\n");
    await expect(service.inspectLatestBackupTrust()).resolves.toMatchObject({
      backupId: "nightly-runtime-snapshot",
      verified: false,
      contractVerified: false,
      issueCodes: expect.arrayContaining(["payload_size_mismatch"]),
    });

    // Restore the fixture so the existing restore proof below still exercises a
    // valid, verified published backup.
    await fs.writeFile(
      path.join(created.outputPath, "payload", "data", "transcripts", "session.jsonl"),
      '{"event":"hello"}\n',
    );

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

  it("skips config atomic-write staging paths before stat while preserving committed config", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-config-atomic-race-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const configDir = path.join(rootDir, "config");
    const generationTempPath = path.join(configDir, ".goatcitadel-11111111-2222-4333-8444-555555555555.tmp");
    const configSyncTempPath = path.join(configDir, "llm-providers.json.tmp-42-mabc123-abcdef");
    const stagingDir = path.join(configDir, ".generations", "staging", "66666666-7777-4888-8999-aaaaaaaaaaaa");
    const committedHiddenPath = path.join(configDir, ".operator-metadata.json");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(generationTempPath, '{"state":"uncommitted"}\n', "utf8");
    await fs.writeFile(configSyncTempPath, '{"state":"uncommitted"}\n', "utf8");
    await fs.writeFile(path.join(stagingDir, "assistant.config.json"), '{"state":"staged"}\n', "utf8");
    await fs.writeFile(committedHiddenPath, '{"state":"committed"}\n', "utf8");

    const originalCp = fs.cp.bind(fs);
    let disappearingTempWasFiltered = false;
    vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (source === configDir && options?.filter) {
        const originalFilter = options.filter;
        await originalCp(source, destination, {
          ...options,
          filter: async (candidateSource, candidateDestination) => {
            const included = await originalFilter(candidateSource, candidateDestination);
            if (candidateSource === generationTempPath) {
              disappearingTempWasFiltered = !included;
              // Model the production race exactly: the atomic writer renames
              // the enumerated temp file before fs.cp would lstat it.
              await fs.rm(generationTempPath, { force: true });
            }
            return included;
          },
        });
        return;
      }
      await originalCp(source, destination, options);
    });

    const service = new BackupRetentionService({
      storage: createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") }),
      config: createConfig(rootDir),
    });
    const created = await service.createBackup({ name: "config-atomic-race" });
    const configPaths = created.manifest.files.map((file) => file.path).filter((file) => file.startsWith("config/"));

    expect(disappearingTempWasFiltered).toBe(true);
    expect(configPaths).toContain("config/assistant.config.json");
    expect(configPaths).toContain("config/.operator-metadata.json");
    expect(configPaths).not.toEqual(
      expect.arrayContaining([
        "config/.goatcitadel-11111111-2222-4333-8444-555555555555.tmp",
        "config/llm-providers.json.tmp-42-mabc123-abcdef",
        "config/.generations/staging/66666666-7777-4888-8999-aaaaaaaaaaaa/assistant.config.json",
      ]),
    );
    await expect(service.verifyBackup({ filePath: created.outputPath })).resolves.toMatchObject({
      verified: true,
      contractVerified: true,
      issues: [],
    });
  });

  it("fails backup creation when a committed config file disappears during the snapshot", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-config-canonical-race-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const configDir = path.join(rootDir, "config");
    const canonicalConfigPath = path.join(configDir, "assistant.config.json");
    const originalCp = fs.cp.bind(fs);
    let canonicalRaceInjected = false;
    vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (source === configDir && options?.filter) {
        const originalFilter = options.filter;
        await originalCp(source, destination, {
          ...options,
          filter: async (candidateSource, candidateDestination) => {
            const included = await originalFilter(candidateSource, candidateDestination);
            if (!canonicalRaceInjected && candidateSource === canonicalConfigPath) {
              canonicalRaceInjected = true;
              expect(included).toBe(true);
              await fs.rm(canonicalConfigPath, { force: true });
            }
            return included;
          },
        });
        return;
      }
      await originalCp(source, destination, options);
    });

    const service = new BackupRetentionService({
      storage: createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") }),
      config: createConfig(rootDir),
    });

    await expect(service.createBackup({ name: "canonical-config-race" })).rejects.toMatchObject({
      code: "ENOENT",
      path: canonicalConfigPath,
    });
    expect(canonicalRaceInjected).toBe(true);
    await expect(fs.readdir(backupDir)).resolves.toEqual([]);
  });

  it("rejects a published backup path swap and cleans its private inspection staging", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-path-swap-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const storage = createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") });
    const service = new BackupRetentionService({ storage, config: createConfig(rootDir) });
    const created = await service.createBackup({ name: "path-swap" });
    const originalCp = fs.cp.bind(fs);
    const swappedPath = `${created.outputPath}.swapped`;
    let swapped = false;

    vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (!swapped && source === created.outputPath) {
        swapped = true;
        await fs.rename(created.outputPath, swappedPath);
        await originalCp(swappedPath, created.outputPath, { recursive: true });
      }
      await originalCp(source, destination, options);
    });

    const tempEntriesBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("goatcitadel-backup-trust-")),
    );
    await expect(service.inspectLatestBackupTrust()).rejects.toThrow(/Published backup changed/);
    const leakedInspectionRoots = (await fs.readdir(os.tmpdir())).filter(
      (entry) => entry.startsWith("goatcitadel-backup-trust-") && !tempEntriesBefore.has(entry),
    );
    expect(swapped).toBe(true);
    expect(leakedInspectionRoots).toEqual([]);
  });

  it("runs the storage-owned online snapshot through semantic verification and restore without changing live DB/WAL bytes", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-online-snapshot-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const databasePath = path.join(rootDir, "data", "index.db");
    const liveDatabase = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      liveDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      liveDatabase.prepare("INSERT INTO backup_fixture (id, value) VALUES (?, ?)").run(2, "online snapshot");
      const walPath = `${databasePath}-wal`;
      const databaseBefore = await fs.readFile(databasePath);
      const walBefore = await fs.readFile(walPath);
      expect(walBefore.length).toBeGreaterThan(0);

      const storage = createStorageMock({
        snapshotImpl: async (destinationPath) => {
          await backup(liveDatabase, destinationPath, { rate: 1 });
          const stagedSnapshot = new DatabaseSync(destinationPath);
          try {
            stagedSnapshot.prepare("PRAGMA journal_mode = DELETE").get();
          } finally {
            stagedSnapshot.close();
          }
        },
      });
      const service = new BackupRetentionService({ storage, config: createConfig(rootDir) });
      const created = await service.createBackup({ name: "online-snapshot" });

      await expect(fs.readFile(databasePath)).resolves.toEqual(databaseBefore);
      await expect(fs.readFile(walPath)).resolves.toEqual(walBefore);
      expect(created.manifest.files.map((file) => file.path)).not.toEqual(
        expect.arrayContaining(["data/index.db-wal", "data/index.db-shm"]),
      );
      await expect(service.verifyBackup({ filePath: created.outputPath })).resolves.toMatchObject({
        verified: true,
        contractVerified: true,
        issues: [],
      });

      const restoreRoot = await makeTempDir("gc-restore-online-snapshot-");
      await expect(
        restoreBackupOffline({
          rootDir: restoreRoot,
          filePath: created.outputPath,
          backupDir,
          confirm: true,
        }),
      ).resolves.toMatchObject({ restored: true, backupId: "online-snapshot" });
      const restoredDatabase = new DatabaseSync(path.join(restoreRoot, "data", "index.db"), { readOnly: true });
      try {
        expect(restoredDatabase.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
        expect(restoredDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(restoredDatabase.prepare("SELECT value FROM backup_fixture WHERE id = 2").get()).toMatchObject({
          value: "online snapshot",
        });
      } finally {
        restoredDatabase.close();
      }
    } finally {
      liveDatabase.close();
    }
  });

  it("cleans private staging after an online snapshot failure", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-snapshot-failure-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    let stagedDatabasePath: string | undefined;
    const storage = createStorageMock({
      snapshotImpl: async (destinationPath) => {
        stagedDatabasePath = destinationPath;
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.writeFile(destinationPath, "partial snapshot");
        throw new Error("injected online snapshot failure");
      },
    });
    const service = new BackupRetentionService({ storage, config: createConfig(rootDir) });

    await expect(service.createBackup({ name: "snapshot-failure" })).rejects.toThrow(
      "injected online snapshot failure",
    );
    expect(stagedDatabasePath).toMatch(/[\\/]payload[\\/]data[\\/]index\.db$/);
    expect(path.relative(backupDir, stagedDatabasePath ?? "").startsWith("..")).toBe(false);
    await expect(fs.readdir(backupDir)).resolves.toEqual([]);
  });

  it("fails closed for legacy injected SQLite storage and out-of-root database paths", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-snapshot-contract-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const legacyStorage = createStorageMock({
      sqliteSourcePath: path.join(rootDir, "data", "index.db"),
    }) as unknown as { createSqliteSnapshot?: (destinationPath: string) => Promise<void> };
    delete legacyStorage.createSqliteSnapshot;

    await expect(
      new BackupRetentionService({ storage: legacyStorage as never, config: createConfig(rootDir) }).createBackup({
        name: "legacy-client",
      }),
    ).rejects.toThrow("configured storage does not support online SQLite snapshots");
    await expect(fs.readdir(backupDir)).resolves.toEqual([]);

    const outsideRoot = await makeTempDir("gc-outside-database-");
    const storage = createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") });
    const unsafeConfig = createConfig(rootDir);
    unsafeConfig.dbPath = path.join(outsideRoot, "index.db");
    await expect(
      new BackupRetentionService({ storage, config: unsafeConfig }).createBackup({ name: "unsafe-db-path" }),
    ).rejects.toThrow("Path escapes allowed root");
    expect(storage.createSqliteSnapshot).not.toHaveBeenCalled();
    await expect(fs.readdir(backupDir)).resolves.toEqual([]);
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

    // Backups are written as directories in production (createBackup → `<id>.backup` dir), so
    // the test must use directories too — otherwise it silently exercises a representation the
    // prune path never sees (which is exactly how the retention bug went unnoticed).
    const oldBackup = path.join(backupDir, "old.backup");
    const newBackup = path.join(backupDir, "new.backup");
    await fs.mkdir(oldBackup, { recursive: true });
    await fs.mkdir(newBackup, { recursive: true });
    await fs.writeFile(path.join(oldBackup, "manifest.json"), "old", "utf8");
    await fs.writeFile(path.join(newBackup, "manifest.json"), "new", "utf8");
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

  it("uses the active transcript backend for retention when available", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const transcriptBackend = {
      pruneOlderThan: vi.fn(async () => ({ removedFiles: 0, removedEvents: 4, reclaimedBytes: 0 })),
    };
    const storage = createStorageMock({
      dialect: "postgres",
      transcripts: transcriptBackend,
      systemSetting: {
        realtimeEventsDays: 2,
        backupsKeep: 5,
        transcriptsDays: 1,
      },
    });
    const service = new BackupRetentionService({
      storage,
      config: createConfig(rootDir),
    });

    const result = await service.pruneRetention({ dryRun: false });

    expect(result).toMatchObject({
      applied: true,
      removedTranscriptFiles: 4,
    });
    expect(transcriptBackend.pruneOlderThan).toHaveBeenCalledWith(expect.any(String), { dryRun: false });
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

  for (const scenario of ["corrupt", "foreign-key-violation"] as const) {
    it(`refuses to restore a checksum-valid SQLite backup with ${scenario} before mutating the runtime`, async () => {
      const rootDir = await createRuntimeFixture();
      const backupDir = await makeTempDir("gc-backups-invalid-sqlite-");
      vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
      if (scenario === "foreign-key-violation") {
        await replaceWithForeignKeyViolation(path.join(rootDir, "data", "index.db"));
      }
      const service = new BackupRetentionService({
        storage: createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") }),
        config: createConfig(rootDir),
      });
      const created = await service.createBackup({ name: `invalid-${scenario}` });
      if (scenario === "corrupt") {
        await replaceBackupDatabaseWithChecksumValidCorruption(created.outputPath);
      }

      const restoreRoot = await makeTempDir("gc-restore-invalid-sqlite-");
      const existingDatabasePath = path.join(restoreRoot, "data", "index.db");
      await fs.mkdir(path.dirname(existingDatabasePath), { recursive: true });
      await fs.writeFile(existingDatabasePath, "existing runtime data\n", "utf8");

      await expect(
        restoreBackupOffline({
          rootDir: restoreRoot,
          filePath: created.outputPath,
          backupDir,
          confirm: true,
        }),
      ).rejects.toThrow(scenario === "corrupt" ? "sqlite_integrity_check_failed" : "sqlite_foreign_key_check_failed");
      await expect(fs.readFile(existingDatabasePath, "utf8")).resolves.toBe("existing runtime data\n");
    });
  }

  it("rejects a corrupt legacy SQLite payload using a Windows-equivalent target path before mutation", async () => {
    const backupDir = await makeTempDir("gc-backups-case-alias-");
    const backupPath = await createManualBackup(backupDir, "case-alias", [
      { payloadPath: "Data/index.db", bytes: Buffer.from("not sqlite\n") },
      { payloadPath: "data/transcripts/session.jsonl", bytes: Buffer.from("{}\n") },
      { payloadPath: "data/audit/events.jsonl", bytes: Buffer.from("{}\n") },
      { payloadPath: "config/assistant.config.json", bytes: Buffer.from("{}\n") },
    ]);
    const restoreRoot = await makeTempDir("gc-restore-case-alias-");
    const existingDatabasePath = path.join(restoreRoot, "data", "index.db");
    await fs.mkdir(path.dirname(existingDatabasePath), { recursive: true });
    await fs.writeFile(existingDatabasePath, "existing runtime data\n");

    await expect(
      restoreBackupOffline({ rootDir: restoreRoot, filePath: backupPath, backupDir, confirm: true }),
    ).rejects.toThrow("manifest_invalid_path");
    await expect(fs.readFile(existingDatabasePath, "utf8")).resolves.toBe("existing runtime data\n");
  });

  it("never file-copies a Postgres dump whose manifest used Windows separators", async () => {
    const backupDir = await makeTempDir("gc-backups-postgres-alias-");
    const backupPath = await createManualBackup(
      backupDir,
      "postgres-alias",
      [
        {
          payloadPath: "database/postgres.dump",
          manifestPath: "database\\postgres.dump",
          bytes: Buffer.from("opaque pg dump\n"),
        },
        { payloadPath: "data/transcripts/session.jsonl", bytes: Buffer.from("{}\n") },
        { payloadPath: "data/audit/events.jsonl", bytes: Buffer.from("{}\n") },
        { payloadPath: "config/assistant.config.json", bytes: Buffer.from("{}\n") },
      ],
      {
        databasePaths: ["database\\postgres.dump"],
        transcriptPaths: ["data/transcripts/session.jsonl"],
        auditPaths: ["data/audit/events.jsonl"],
        configPaths: ["config/assistant.config.json"],
      },
    );
    const restoreRoot = await makeTempDir("gc-restore-postgres-alias-");
    const sentinelPath = path.join(restoreRoot, "sentinel.txt");
    await fs.writeFile(sentinelPath, "untouched\n");

    await expect(
      restoreBackupOffline({ rootDir: restoreRoot, filePath: backupPath, backupDir, confirm: true }),
    ).rejects.toThrow("Postgres backups must be restored with pg_restore");
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("untouched\n");
    await expect(fs.access(path.join(restoreRoot, "database", "postgres.dump"))).rejects.toThrow();
  });

  it("restores from the verified staged bytes when the selected backup changes before target copy", async () => {
    const rootDir = await createRuntimeFixture();
    const backupDir = await makeTempDir("gc-backups-stage-binding-");
    vi.stubEnv("GOATCITADEL_BACKUP_DIR", backupDir);
    const service = new BackupRetentionService({
      storage: createStorageMock({ sqliteSourcePath: path.join(rootDir, "data", "index.db") }),
      config: createConfig(rootDir),
    });
    const created = await service.createBackup({ name: "stage-binding" });
    const originalConfig = await fs.readFile(
      path.join(created.outputPath, "payload", "config", "assistant.config.json"),
      "utf8",
    );
    const originalCopyFile = fs.copyFile.bind(fs);
    let sourceMutated = false;
    vi.spyOn(fs, "copyFile").mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
      if (!sourceMutated) {
        sourceMutated = true;
        await fs.writeFile(
          path.join(created.outputPath, "payload", "config", "assistant.config.json"),
          '{"mutatedAfterVerification":true}\n',
        );
      }
      await originalCopyFile(...args);
    });

    const restoreRoot = await makeTempDir("gc-restore-stage-binding-");
    await expect(
      restoreBackupOffline({ rootDir: restoreRoot, filePath: created.outputPath, backupDir, confirm: true }),
    ).resolves.toMatchObject({ restored: true });
    expect(sourceMutated).toBe(true);
    await expect(fs.readFile(path.join(restoreRoot, "config", "assistant.config.json"), "utf8")).resolves.toBe(
      originalConfig,
    );
  });

  it("verifies a WAL-mode backup repeatedly without mutating sidecars, then restores it", async () => {
    const backupDir = await makeTempDir("gc-backups-wal-sidecar-");
    const backupPath = await createWalSidecarBackup(backupDir);
    const shmPath = path.join(backupPath, "payload", "data", "index.db-shm");
    const shmBefore = await fs.readFile(shmPath);

    await expect(verifyBackupOffline({ filePath: backupPath, backupDir })).resolves.toMatchObject({
      verified: true,
      contractVerified: true,
    });
    await expect(verifyBackupOffline({ filePath: backupPath, backupDir })).resolves.toMatchObject({
      verified: true,
      contractVerified: true,
    });
    await expect(fs.readFile(shmPath)).resolves.toEqual(shmBefore);

    const restoreRoot = await makeTempDir("gc-restore-wal-sidecar-");
    await expect(
      restoreBackupOffline({ rootDir: restoreRoot, filePath: backupPath, backupDir, confirm: true }),
    ).resolves.toMatchObject({ restored: true });
    await expect(fs.readFile(shmPath)).resolves.toEqual(shmBefore);
    const restored = new DatabaseSync(path.join(restoreRoot, "data", "index.db"), { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM backup_fixture WHERE id = 1").get()).toMatchObject({
        value: "wal snapshot",
      });
    } finally {
      restored.close();
    }
  });
});

async function createRuntimeFixture(): Promise<string> {
  const rootDir = await makeTempDir("gc-runtime-");
  await fs.mkdir(path.join(rootDir, "data", "transcripts"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "data", "audit"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  const db = new DatabaseSync(path.join(rootDir, "data", "index.db"));
  try {
    db.exec("CREATE TABLE backup_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    db.exec("INSERT INTO backup_fixture (value) VALUES ('sqlite');");
  } finally {
    db.close();
  }
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

async function replaceWithForeignKeyViolation(databasePath: string): Promise<void> {
  await fs.rm(databasePath, { force: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (parent_id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        child_id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(parent_id)
      );
      INSERT INTO children (child_id, parent_id) VALUES (1, 999);
    `);
  } finally {
    db.close();
  }
}

async function replaceBackupDatabaseWithChecksumValidCorruption(backupPath: string): Promise<void> {
  const databasePath = path.join(backupPath, "payload", "data", "index.db");
  const corruptBytes = Buffer.from("checksum-valid but not sqlite\n", "utf8");
  await fs.writeFile(databasePath, corruptBytes);
  const manifestPath = path.join(backupPath, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
  const databaseEntry = manifest.files.find((file) => file.path === "data/index.db");
  if (!databaseEntry) {
    throw new Error("backup fixture is missing data/index.db");
  }
  databaseEntry.sizeBytes = corruptBytes.length;
  databaseEntry.sha256 = createHash("sha256").update(corruptBytes).digest("hex");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function createManualBackup(
  backupDir: string,
  name: string,
  entries: Array<{ payloadPath: string; manifestPath?: string; bytes: Buffer }>,
  minimumSet?: {
    databasePaths: string[];
    transcriptPaths: string[];
    auditPaths: string[];
    configPaths: string[];
  },
): Promise<string> {
  const backupPath = path.join(backupDir, `${name}.backup`);
  for (const entry of entries) {
    const target = path.join(backupPath, "payload", entry.payloadPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.bytes);
  }
  const manifest = {
    backupId: name,
    createdAt: "2026-07-12T00:00:00.000Z",
    appVersion: "1.0.0",
    rootDir: "F:/code/personal-ai",
    files: entries.map((entry) => ({
      path: entry.manifestPath ?? entry.payloadPath,
      sizeBytes: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
    ...(minimumSet
      ? {
          contractCoverage: {
            contractVersion: "1.0",
            minimumSet,
          },
        }
      : {}),
  };
  await fs.writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return backupPath;
}

async function createWalSidecarBackup(backupDir: string): Promise<string> {
  const sourceRoot = await makeTempDir("gc-wal-source-");
  const databasePath = path.join(sourceRoot, "index.db");
  const db = new DatabaseSync(databasePath);
  let entries: Array<{ payloadPath: string; bytes: Buffer }>;
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE backup_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO backup_fixture (id, value) VALUES (1, 'wal snapshot');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    entries = [
      { payloadPath: "data/index.db", bytes: await fs.readFile(databasePath) },
      { payloadPath: "data/index.db-shm", bytes: await fs.readFile(`${databasePath}-shm`) },
      { payloadPath: "data/index.db-wal", bytes: await fs.readFile(`${databasePath}-wal`) },
      { payloadPath: "data/transcripts/session.jsonl", bytes: Buffer.from("{}\n") },
      { payloadPath: "data/audit/events.jsonl", bytes: Buffer.from("{}\n") },
      {
        payloadPath: "config/assistant.config.json",
        bytes: Buffer.from('{"database":{"driver":"sqlite"}}\n'),
      },
    ];
  } finally {
    db.close();
  }
  return createManualBackup(backupDir, "wal-sidecar", entries, {
    databasePaths: ["data/index.db"],
    transcriptPaths: ["data/transcripts/session.jsonl"],
    auditPaths: ["data/audit/events.jsonl"],
    configPaths: ["config/assistant.config.json"],
  });
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

function createStorageMock(options?: {
  systemSetting?: unknown;
  realtimeCount?: number;
  dialect?: "sqlite" | "postgres";
  transcripts?: unknown;
  sqliteSourcePath?: string;
  snapshotImpl?: (destinationPath: string) => Promise<void>;
}) {
  let stored = options?.systemSetting;
  const createSqliteSnapshot = vi.fn(async (destinationPath: string) => {
    if (options?.snapshotImpl) {
      await options.snapshotImpl(destinationPath);
      return;
    }
    if (!options?.sqliteSourcePath) {
      throw new Error("SQLite snapshot test fixture is missing sqliteSourcePath");
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(options.sqliteSourcePath, destinationPath);
  });
  return {
    db: {
      dialect: options?.dialect ?? "sqlite",
    },
    transcripts: options?.transcripts,
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
    createSqliteSnapshot,
  } as never;
}

async function setAge(filePath: string, daysAgo: number): Promise<void> {
  const epochSeconds = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(filePath, epochSeconds, epochSeconds);
}
