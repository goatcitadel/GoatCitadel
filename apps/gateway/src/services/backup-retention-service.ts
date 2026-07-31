import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  BackupCreateResponse,
  BackupManifestContractCoverageRecord,
  BackupManifestFileRecord,
  BackupManifestRecord,
  BackupVerifyResponse,
  RetentionPolicy,
  RetentionPruneResult,
} from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildBundledDockerContainerName } from "../bundled-postgres-runtime.js";
import { isWindowsEquivalentBackupPath, verifyBackupAtPath } from "./gateway/backup-verify.js";
import type { GatewayRuntimeConfig } from "../config.js";
import { resolveGatewayPostgresConnectionString } from "../postgres-runtime-config.js";
import { resolveBackupDirectory, resolveBackupPathWithinDirectory } from "./backup-paths.js";

const RETENTION_SETTINGS_KEY = "retention_policy";
const CONFIG_GENERATION_TEMP_FILE_PATTERN = /^\..+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/iu;
const CONFIG_SYNC_TEMP_FILE_PATTERN = /\.tmp-\d+-[a-z0-9]+-[a-z0-9]+$/iu;

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  realtimeEventsDays: 14,
  backupsKeep: 20,
  transcriptsDays: undefined,
  auditDays: undefined,
};

export interface BackupRetentionDeps {
  readonly storage: Storage;
  readonly config: GatewayRuntimeConfig;
}

/** Secret-free trust result for the newest published backup directory. */
export interface LatestBackupTrustInspection {
  observedAt: string;
  backupId?: string;
  createdAt?: string;
  verified: boolean;
  contractVerified: boolean;
  issueCodes: string[];
}

export async function restoreBackupOffline(input: {
  rootDir: string;
  filePath: string;
  confirm: boolean;
  backupDir?: string;
}): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
  if (!input.confirm) {
    throw new Error("Backup restore requires explicit confirm=true");
  }

  const runtimeRoot = path.resolve(input.rootDir);
  const resolvedBackup = resolveBackupPathWithinDirectory(input.filePath, input.backupDir);
  if (!resolvedBackup.ok) {
    throw new Error(resolvedBackup.error);
  }
  const restoreStageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-restore-"));
  try {
    // Bind verification and restore to one private materialized copy. The
    // operator-selected archive may otherwise change after verification and
    // before file-copy restore consumes it.
    const stagedBackupPath = path.join(restoreStageRoot, "backup");
    await fs.cp(resolvedBackup.resolvedPath, stagedBackupPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const verification = await verifyBackupAtPath(stagedBackupPath);
    if (!verification.verified || !verification.manifest) {
      throw new Error(formatBackupVerifyFailure(verification));
    }

    const payloadDir = path.join(stagedBackupPath, "payload");
    const manifest = verification.manifest;
    if (manifest.files.some((file) => isWindowsEquivalentBackupPath(file.path, "database/postgres.dump"))) {
      throw new Error(
        "Postgres backups must be restored with pg_restore; file-copy restore is only available for SQLite backups.",
      );
    }

    let filesRestored = 0;
    for (const file of manifest.files) {
      if (isEphemeralSqliteSidecar(file.path)) {
        continue;
      }
      const source = path.resolve(payloadDir, file.path);
      ensurePathWithinRoot(source, payloadDir);
      const target = path.resolve(runtimeRoot, file.path);
      ensurePathWithinRoot(target, runtimeRoot);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      await restrictCredentialFilePermsIfSensitive(target, file.path);
      filesRestored += 1;
    }

    return {
      restored: true,
      backupId: manifest.backupId,
      filesRestored,
    };
  } finally {
    await fs.rm(restoreStageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyBackupAtRuntime(
  _config: GatewayRuntimeConfig,
  input: { filePath: string },
): Promise<BackupVerifyResponse> {
  return verifyBackupOffline(input);
}

export async function verifyBackupOffline(input: {
  filePath: string;
  backupDir?: string;
}): Promise<BackupVerifyResponse> {
  const resolvedBackup = resolveBackupPathWithinDirectory(input.filePath, input.backupDir);
  if (!resolvedBackup.ok) {
    throw new Error(resolvedBackup.error);
  }
  return verifyBackupAtPath(resolvedBackup.resolvedPath);
}

export class BackupRetentionService {
  private readonly storage: Storage;
  private readonly config: GatewayRuntimeConfig;

  public constructor(deps: BackupRetentionDeps) {
    this.storage = deps.storage;
    this.config = deps.config;
  }

  private get gatewaySql() {
    return this.storage.gatewaySql;
  }

  // ── Backups ──────────────────────────────────────────────────────────

  public async listBackups(limit = 50): Promise<BackupManifestRecord[]> {
    const backupDir = this.getBackupDirectory();
    const entries = await listFilesSafe(backupDir);
    const manifests: BackupManifestRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".backup")) {
        continue;
      }
      const manifestPath = path.join(backupDir, entry.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as BackupManifestRecord;
        manifests.push(parsed);
      } catch {
        // skip invalid backup folders
      }
    }
    manifests.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return manifests.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  /**
   * Verify the newest published backup against its manifest without exposing
   * the runtime backup directory, payload paths, or issue text to callers.
   */
  public async inspectLatestBackupTrust(): Promise<LatestBackupTrustInspection | undefined> {
    const backupDir = this.getBackupDirectory();
    const latest = (await listFilesSafe(backupDir))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".backup"))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (!latest) {
      return undefined;
    }

    const observedAt = new Date().toISOString();
    const inspectionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-trust-"));
    try {
      const publishedBackupPath = path.join(backupDir, latest.name);
      const selectedIdentity = await assertStablePublishedBackupDirectory(publishedBackupPath, backupDir, latest);
      const stagedBackupPath = path.join(inspectionRoot, "backup");
      await fs.cp(publishedBackupPath, stagedBackupPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await assertStablePublishedBackupDirectory(publishedBackupPath, backupDir, selectedIdentity);
      const verification = await verifyBackupAtPath(stagedBackupPath);
      return {
        observedAt,
        backupId: verification.backupId,
        createdAt: verification.manifest?.createdAt,
        verified: verification.verified,
        contractVerified: verification.contractVerified,
        issueCodes: verification.issues.slice(0, 20).map((issue) => issue.code.slice(0, 80)),
      };
    } finally {
      await fs.rm(inspectionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async createBackup(input?: { name?: string; outputPath?: string }): Promise<BackupCreateResponse> {
    const now = new Date();
    const timestamp = formatBackupTimestamp(now);
    const backupId = sanitizeBackupName(input?.name) ?? `backup-${timestamp}-${randomUUID().slice(0, 8)}`;
    const backupDir = path.resolve(this.getBackupDirectory());
    const outputPath = input?.outputPath
      ? path.resolve(backupDir, input.outputPath)
      : path.join(backupDir, `${backupId}.backup`);
    ensurePathWithinRoot(outputPath, backupDir);
    const tempDir = `${outputPath}.tmp-${randomUUID().slice(0, 8)}`;
    ensurePathWithinRoot(tempDir, backupDir);
    const payloadDir = path.join(tempDir, "payload");
    let published = false;
    try {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.mkdir(payloadDir, { recursive: true });

      if (this.config.assistant.database.driver === "postgres") {
        await this.exportPostgresDump(payloadDir);
        for (const includePath of this.buildBackupIncludePaths()) {
          const source = path.resolve(this.config.rootDir, includePath);
          const target = path.join(payloadDir, includePath);
          await copyPathIfExists(source, target, buildBackupCopyFilter(includePath, source));
        }
      } else {
        await this.snapshotSqliteDatabase(payloadDir);
        for (const includePath of this.buildBackupIncludePaths()) {
          const source = path.resolve(this.config.rootDir, includePath);
          const target = path.join(payloadDir, includePath);
          await copyPathIfExists(source, target, buildBackupCopyFilter(includePath, source));
        }
      }

      const files = await collectBackupFileRecords(payloadDir);
      const manifest: BackupManifestRecord = {
        backupId,
        createdAt: now.toISOString(),
        appVersion: readAppVersion(),
        gitRef: readGitRef(this.config.rootDir),
        rootDir: this.config.rootDir,
        files,
        contractCoverage: buildBackupManifestContractCoverage(files),
      };
      const manifestPath = path.join(tempDir, "manifest.json");
      const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
      await fs.writeFile(manifestPath, manifestRaw, "utf8");

      await fs.rm(outputPath, { recursive: true, force: true });
      await fs.rename(tempDir, outputPath);
      published = true;

      return {
        backupId,
        outputPath,
        bytes: files.reduce((sum, item) => sum + item.sizeBytes, 0) + Buffer.byteLength(manifestRaw, "utf8"),
        manifest,
      };
    } finally {
      if (!published) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  public async verifyBackup(input: { filePath: string }): Promise<BackupVerifyResponse> {
    return verifyBackupAtRuntime(this.config, input);
  }

  // ── Retention ────────────────────────────────────────────────────────

  public getRetentionPolicy(): RetentionPolicy {
    const stored = this.storage.systemSettings.get<RetentionPolicy>(RETENTION_SETTINGS_KEY)?.value;
    return normalizeRetentionPolicy(stored ?? DEFAULT_RETENTION_POLICY);
  }

  public updateRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
    const current = this.getRetentionPolicy();
    const merged = normalizeRetentionPolicy({
      ...current,
      ...input,
    });
    this.storage.systemSettings.set(RETENTION_SETTINGS_KEY, merged);
    return merged;
  }

  public async pruneRetention(options: { dryRun?: boolean } = {}): Promise<RetentionPruneResult> {
    const policy = this.getRetentionPolicy();
    const dryRun = options.dryRun ?? true;
    const startedAt = new Date().toISOString();
    let removedTranscriptFiles = 0;
    let removedAuditFiles = 0;
    let reclaimedBytes = 0;

    const realtimeCutoff = new Date(Date.now() - policy.realtimeEventsDays * 24 * 60 * 60 * 1000).toISOString();
    const realtimeCountRow = this.gatewaySql
      .prepare("SELECT COUNT(*) AS count FROM realtime_events WHERE created_at < ?")
      .get(realtimeCutoff) as { count: number } | undefined;
    const removedRealtimeEvents = Number(realtimeCountRow?.count ?? 0);
    if (!dryRun && removedRealtimeEvents > 0) {
      this.storage.realtimeEvents.pruneOlderThan(realtimeCutoff);
    }

    const backupDir = this.getBackupDirectory();
    const backupEntries = await listFilesSafe(backupDir);
    // Backups are written as directories (`<id>.backup`), mirroring listBackups(); filtering
    // for isFile() here matched nothing, so retention silently never pruned and disk grew
    // unbounded. Filter for the real backup directories and remove them recursively.
    const sortedBackups = backupEntries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".backup"))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const removableBackups = sortedBackups.slice(Math.max(0, policy.backupsKeep));
    const removedBackupFiles = removableBackups.length;
    for (const backup of removableBackups) {
      const backupPath = path.join(backupDir, backup.name);
      reclaimedBytes += await directorySizeBytes(backupPath);
      if (!dryRun) {
        await fs.rm(backupPath, { recursive: true, force: true });
      }
    }

    if (policy.transcriptsDays !== undefined) {
      const transcriptsDir = path.resolve(this.config.rootDir, this.config.assistant.transcriptsDir);
      const cutoff = Date.now() - policy.transcriptsDays * 24 * 60 * 60 * 1000;
      const pruned = await pruneTranscriptsOlderThan(
        this.storage.transcripts,
        transcriptsDir,
        cutoff,
        dryRun,
        this.storage.db.dialect,
      );
      removedTranscriptFiles = pruned.removedFiles + pruned.removedEvents;
      reclaimedBytes += pruned.reclaimedBytes;
    }

    if (policy.auditDays !== undefined) {
      const auditDir = path.resolve(this.config.rootDir, this.config.assistant.auditDir);
      const cutoff = Date.now() - policy.auditDays * 24 * 60 * 60 * 1000;
      const pruned = await pruneFilesOlderThan(auditDir, cutoff, dryRun);
      removedAuditFiles = pruned.files;
      reclaimedBytes += pruned.bytes;
    }

    return {
      applied: !dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      removedRealtimeEvents,
      removedBackupFiles,
      removedTranscriptFiles,
      removedAuditFiles,
      reclaimedBytes,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private getBackupDirectory(): string {
    return resolveBackupDirectory();
  }

  private buildBackupIncludePaths(): string[] {
    const paths = new Set<string>();
    if (this.config.assistant.database.driver === "sqlite") {
      paths.add(this.config.assistant.transcriptsDir.replaceAll("\\", "/"));
      paths.add(this.config.assistant.auditDir.replaceAll("\\", "/"));
    }
    paths.add("config");
    return [...paths];
  }

  private async snapshotSqliteDatabase(payloadDir: string): Promise<void> {
    const runtimeRoot = path.resolve(this.config.rootDir);
    const sourceDatabasePath = path.resolve(this.config.dbPath);
    ensurePathWithinRoot(sourceDatabasePath, runtimeRoot);
    const databaseRelativePath = path.relative(runtimeRoot, sourceDatabasePath).replaceAll("\\", "/");
    if (
      !databaseRelativePath ||
      databaseRelativePath.startsWith("../") ||
      path.posix.isAbsolute(databaseRelativePath)
    ) {
      throw new Error("SQLite database path must identify a file within the runtime root");
    }
    const targetDatabasePath = path.resolve(payloadDir, databaseRelativePath);
    ensurePathWithinRoot(targetDatabasePath, payloadDir);
    await fs.mkdir(path.dirname(targetDatabasePath), { recursive: true });

    const createSqliteSnapshot = (this.storage as Storage & { createSqliteSnapshot?: Storage["createSqliteSnapshot"] })
      .createSqliteSnapshot;
    if (typeof createSqliteSnapshot !== "function") {
      throw new Error("The configured storage does not support online SQLite snapshots");
    }
    await createSqliteSnapshot.call(this.storage, targetDatabasePath);
  }

  private async exportPostgresDump(payloadDir: string): Promise<void> {
    const connectionString = resolveGatewayPostgresConnectionString(this.config);
    if (!connectionString) {
      throw new Error("Postgres backup requested but no connection string could be resolved.");
    }
    const databaseDir = path.join(payloadDir, "database");
    await fs.mkdir(databaseDir, { recursive: true });
    const dumpPath = path.join(databaseDir, "postgres.dump");
    if (this.config.assistant.database.postgres.mode === "bundled") {
      const bundledDump = tryDumpViaBundledDocker(this.config, connectionString);
      if (bundledDump) {
        await fs.writeFile(dumpPath, bundledDump);
        return;
      }
    }
    const pgDumpCommand = resolvePgDumpCommand(this.config);
    execFileSync(pgDumpCommand, ["--format=custom", "--file", dumpPath, connectionString], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

interface TranscriptRetentionBackend {
  pruneOlderThan(
    cutoff: string | number,
    options?: { dryRun?: boolean },
  ): Promise<{ removedFiles: number; removedEvents: number; reclaimedBytes: number }>;
}

async function pruneTranscriptsOlderThan(
  transcripts: unknown,
  transcriptsDir: string,
  cutoffEpochMs: number,
  dryRun: boolean,
  dialect: "sqlite" | "postgres",
): Promise<{ removedFiles: number; removedEvents: number; reclaimedBytes: number }> {
  if (hasTranscriptRetentionBackend(transcripts)) {
    const cutoff = dialect === "postgres" ? new Date(cutoffEpochMs).toISOString() : cutoffEpochMs;
    return transcripts.pruneOlderThan(cutoff, { dryRun });
  }
  const pruned = await pruneFilesOlderThan(transcriptsDir, cutoffEpochMs, dryRun);
  return { removedFiles: pruned.files, removedEvents: 0, reclaimedBytes: pruned.bytes };
}

function hasTranscriptRetentionBackend(value: unknown): value is TranscriptRetentionBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pruneOlderThan?: unknown }).pruneOlderThan === "function"
  );
}

// ── Module-level helpers ───────────────────────────────────────────────

function normalizeRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    realtimeEventsDays: clampInt(input.realtimeEventsDays, DEFAULT_RETENTION_POLICY.realtimeEventsDays, 1, 365),
    backupsKeep: clampInt(input.backupsKeep, DEFAULT_RETENTION_POLICY.backupsKeep, 1, 500),
    transcriptsDays: normalizeOptionalDays(input.transcriptsDays),
    auditDays: normalizeOptionalDays(input.auditDays),
  };
}

function normalizeOptionalDays(value: number | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampInt(value, 30, 1, 3650);
}

async function listFilesSafe(dir: string): Promise<
  Array<{
    name: string;
    size: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>
> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: Array<{
      name: string;
      size: number;
      dev: number;
      ino: number;
      mtimeMs: number;
      ctimeMs: number;
      birthtimeMs: number;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }> = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      let stats: fsSync.Stats | undefined;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }
      result.push({
        name: entry.name,
        size: stats.size,
        dev: stats.dev,
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        birthtimeMs: stats.birthtimeMs,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
      });
    }
    return result;
  } catch {
    return [];
  }
}

interface PublishedBackupIdentity {
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

async function assertStablePublishedBackupDirectory(
  backupPath: string,
  backupRoot: string,
  expected: PublishedBackupIdentity,
): Promise<PublishedBackupIdentity> {
  const before = await readPublishedBackupIdentity(backupPath);
  if (!samePublishedBackupIdentity(before, expected)) {
    throw new Error("Published backup changed before trust inspection could bind its bytes.");
  }
  const [realRoot, realBackup] = await Promise.all([fs.realpath(backupRoot), fs.realpath(backupPath)]);
  ensurePathWithinRoot(realBackup, realRoot);
  const after = await readPublishedBackupIdentity(backupPath);
  if (!samePublishedBackupIdentity(before, after)) {
    throw new Error("Published backup changed while trust inspection resolved its path.");
  }
  return after;
}

async function readPublishedBackupIdentity(backupPath: string): Promise<PublishedBackupIdentity> {
  const stats = await fs.lstat(backupPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Published backup must be a stable directory, not a link.");
  }
  return {
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
}

function samePublishedBackupIdentity(left: PublishedBackupIdentity, right: PublishedBackupIdentity): boolean {
  return (
    left.size === right.size &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stats = await fs.stat(fullPath);
        total += stats.size;
      } catch {
        // Unreadable entry; skip it rather than abort the size computation.
      }
    }
  };
  await walk(dir);
  return total;
}

async function pruneFilesOlderThan(
  dir: string,
  cutoffEpochMs: number,
  dryRun: boolean,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let stats: fsSync.Stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stats.mtimeMs >= cutoffEpochMs) {
        continue;
      }
      files += 1;
      bytes += stats.size;
      if (!dryRun) {
        await fs.rm(fullPath, { force: true });
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

type BackupCopyFilter = (sourcePath: string, destinationPath: string) => boolean;

function buildBackupCopyFilter(includePath: string, sourceRoot: string): BackupCopyFilter | undefined {
  if (includePath.replaceAll("\\", "/") !== "config") {
    return undefined;
  }
  return (sourcePath) => shouldCopyRuntimeConfigPath(sourceRoot, sourcePath);
}

function shouldCopyRuntimeConfigPath(configRoot: string, sourcePath: string): boolean {
  const relativePath = path.relative(configRoot, sourcePath).replaceAll("\\", "/");
  if (!relativePath) {
    return true;
  }
  if (relativePath === ".generations/staging" || relativePath.startsWith(".generations/staging/")) {
    return false;
  }

  const fileName = path.posix.basename(relativePath);
  // ConfigGenerationService writes hidden, UUID-suffixed files before an
  // atomic rename. Config sync uses the second same-directory temp convention.
  // Neither represents committed runtime state, and excluding it in fs.cp's
  // pre-stat filter prevents a completed rename from becoming a false ENOENT.
  return !CONFIG_GENERATION_TEMP_FILE_PATTERN.test(fileName) && !CONFIG_SYNC_TEMP_FILE_PATTERN.test(fileName);
}

async function copyPathIfExists(source: string, target: string, filter?: BackupCopyFilter): Promise<void> {
  let stats: fsSync.Stats;
  try {
    stats = await fs.stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true, filter });
    return;
  }
  if (stats.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function collectBackupFileRecords(payloadDir: string): Promise<BackupManifestFileRecord[]> {
  const files: BackupManifestFileRecord[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const bytes = await fs.readFile(fullPath);
      const relativePath = path.relative(payloadDir, fullPath).replaceAll("\\", "/");
      files.push({
        path: relativePath,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await walk(payloadDir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function buildBackupManifestContractCoverage(files: BackupManifestFileRecord[]): BackupManifestContractCoverageRecord {
  const paths = files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
  return {
    contractVersion: "1.0",
    minimumSet: {
      databasePaths: paths.filter(isContractDatabasePath),
      transcriptPaths: paths.filter(isContractTranscriptPath),
      auditPaths: paths.filter(isContractAuditPath),
      configPaths: paths.filter(isContractConfigPath),
    },
  };
}

function formatBackupVerifyFailure(result: BackupVerifyResponse): string {
  if (result.issues.length === 0) {
    return "Backup verification failed.";
  }
  const first = result.issues[0];
  if (!first) {
    return "Backup verification failed.";
  }
  return first.path
    ? `Backup verification failed (${first.code}): ${first.message} [${first.path}]`
    : `Backup verification failed (${first.code}): ${first.message}`;
}

function formatBackupTimestamp(now: Date): string {
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function sanitizeBackupName(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const sanitized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || undefined;
}

function readAppVersion(): string {
  const packagePath = path.resolve(process.cwd(), "package.json");
  try {
    const raw = fsSync.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function readGitRef(rootDir: string): string | undefined {
  try {
    const value = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function ensurePathWithinRoot(targetPath: string, rootDir: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Path escapes allowed root");
}

/**
 * After restoring a sensitive credential file (.env, config/*.json containing
 * auth state, OAuth tokens, signing secrets), lock perms to 0600 so the file
 * is owner-read/write only. No-op on win32 where chmod does not map to ACLs;
 * Windows hardening relies on the parent dir's ACL.
 */
async function restrictCredentialFilePermsIfSensitive(
  absoluteTargetPath: string,
  manifestRelativePath: string,
): Promise<void> {
  if (!isSensitiveCredentialFile(manifestRelativePath)) {
    return;
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    await fs.chmod(absoluteTargetPath, 0o600);
  } catch {
    // best-effort: restore succeeded; some filesystems silently ignore chmod
  }
}

function isSensitiveCredentialFile(manifestRelativePath: string): boolean {
  const normalized = manifestRelativePath.replace(/\\/g, "/");
  if (normalized === ".env" || normalized.endsWith("/.env")) {
    return true;
  }
  if (normalized.startsWith("config/") && normalized.endsWith(".json")) {
    return true;
  }
  return false;
}

function isContractDatabasePath(filePath: string): boolean {
  return filePath === "data/index.db" || filePath === "database/postgres.dump";
}

function isContractTranscriptPath(filePath: string): boolean {
  return filePath.startsWith("data/transcripts/") && filePath.endsWith(".jsonl");
}

function isContractAuditPath(filePath: string): boolean {
  return filePath.startsWith("data/audit/") && filePath.endsWith(".jsonl");
}

function isContractConfigPath(filePath: string): boolean {
  return filePath.startsWith("config/") && filePath.endsWith(".json");
}

function resolvePgDumpCommand(config: GatewayRuntimeConfig): string {
  const explicitPath = process.env.GOATCITADEL_PG_DUMP_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const configuredBinDir = config.assistant.database.bundledPostgres.binDir?.trim();
  if (configuredBinDir) {
    const baseDir = path.isAbsolute(configuredBinDir)
      ? configuredBinDir
      : path.resolve(config.rootDir, configuredBinDir);
    const configuredCommand = path.join(baseDir, process.platform === "win32" ? "pg_dump.exe" : "pg_dump");
    if (fsSync.existsSync(configuredCommand)) {
      return configuredCommand;
    }
  }

  const resolvedOnPath = resolveCommandOnPath(process.platform === "win32" ? "pg_dump.exe" : "pg_dump");
  if (resolvedOnPath) {
    return resolvedOnPath;
  }

  throw new Error(
    "Postgres backup requested but pg_dump is unavailable. Set GOATCITADEL_PG_DUMP_PATH or assistant.database.bundledPostgres.binDir.",
  );
}

function resolveCommandOnPath(command: string): string | undefined {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(locator, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

function isEphemeralSqliteSidecar(filePath: string): boolean {
  return /(\.db|\.sqlite)(-shm|-wal)$/i.test(filePath);
}

function tryDumpViaBundledDocker(config: GatewayRuntimeConfig, connectionString: string): Buffer | undefined {
  if (!canUseDockerCli()) {
    return undefined;
  }
  const containerName = buildBundledDockerContainerName(config.rootDir);
  if (!isDockerContainerRunning(containerName)) {
    return undefined;
  }
  try {
    return execFileSync(
      "docker",
      [
        "exec",
        containerName,
        "pg_dump",
        "--format=custom",
        "--dbname",
        normalizeBundledDockerConnectionString(connectionString),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return undefined;
  }
}

function normalizeBundledDockerConnectionString(connectionString: string): string {
  return connectionString.replace(/@127\.0\.0\.1:\d+\//, "@127.0.0.1:5432/");
}

function canUseDockerCli(): boolean {
  try {
    execFileSync("docker", ["info"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isDockerContainerRunning(containerName: string): boolean {
  try {
    const output = execFileSync("docker", ["ps", "--filter", `name=^/${containerName}$`, "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === containerName;
  } catch {
    return false;
  }
}
