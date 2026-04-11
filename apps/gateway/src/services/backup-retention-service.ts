import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  BackupCreateResponse,
  BackupManifestFileRecord,
  BackupManifestRecord,
  BackupVerifyResponse,
  RetentionPolicy,
  RetentionPruneResult,
} from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildBundledDockerContainerName } from "../bundled-postgres-runtime.js";
import { verifyBackupAtPath } from "./gateway/backup-verify.js";
import type { GatewayRuntimeConfig } from "../config.js";
import { resolveGatewayPostgresConnectionString } from "../postgres-runtime-config.js";

const RETENTION_SETTINGS_KEY = "retention_policy";

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

export async function restoreBackupAtRuntime(
  config: GatewayRuntimeConfig,
  input: {
    filePath: string;
    confirm: boolean;
  },
): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
  if (!input.confirm) {
    throw new Error("Backup restore requires explicit confirm=true");
  }

  const backupDir = path.resolve(resolveBackupDirectory());
  const backupPath = path.resolve(backupDir, input.filePath);
  ensurePathWithinRoot(backupPath, backupDir);
  const verification = await verifyBackupAtRuntime(config, { filePath: input.filePath });
  if (!verification.verified || !verification.manifest) {
    throw new Error(formatBackupVerifyFailure(verification));
  }

  const payloadDir = path.join(backupPath, "payload");
  const manifest = verification.manifest;
  if (manifest.files.some((file) => file.path === "database/postgres.dump")) {
    throw new Error(
      "Postgres backups must be restored with pg_restore; file-copy restore is only available for SQLite backups.",
    );
  }

  for (const file of manifest.files) {
    if (isEphemeralSqliteSidecar(file.path)) {
      continue;
    }
    const source = path.resolve(payloadDir, file.path);
    ensurePathWithinRoot(source, payloadDir);
    const target = path.resolve(config.rootDir, file.path);
    ensurePathWithinRoot(target, config.rootDir);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }

  return {
    restored: true,
    backupId: manifest.backupId,
    filesRestored: manifest.files.length,
  };
}

export async function verifyBackupAtRuntime(
  _config: GatewayRuntimeConfig,
  input: { filePath: string },
): Promise<BackupVerifyResponse> {
  const backupDir = path.resolve(resolveBackupDirectory());
  const backupPath = path.resolve(backupDir, input.filePath);
  ensurePathWithinRoot(backupPath, backupDir);
  return verifyBackupAtPath(backupPath);
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

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(payloadDir, { recursive: true });

    if (this.config.assistant.database.driver === "postgres") {
      await this.exportPostgresDump(payloadDir);
      for (const includePath of this.buildBackupIncludePaths()) {
        const source = path.resolve(this.config.rootDir, includePath);
        const target = path.join(payloadDir, includePath);
        await copyPathIfExists(source, target);
      }
    } else {
      this.checkpointSqliteBeforeBackup();
      const includePaths = this.buildBackupIncludePaths();
      for (const includePath of includePaths) {
        const source = path.resolve(this.config.rootDir, includePath);
        const target = path.join(payloadDir, includePath);
        await copyPathIfExists(source, target);
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
    };
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(manifestPath, manifestRaw, "utf8");

    await fs.rm(outputPath, { recursive: true, force: true });
    await fs.rename(tempDir, outputPath);

    return {
      backupId,
      outputPath,
      bytes: files.reduce((sum, item) => sum + item.sizeBytes, 0) + Buffer.byteLength(manifestRaw, "utf8"),
      manifest,
    };
  }

  public async restoreBackup(input: {
    filePath: string;
    confirm: boolean;
  }): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
    return restoreBackupAtRuntime(this.config, input);
  }

  public async verifyBackup(input: { filePath: string }): Promise<BackupVerifyResponse> {
    return verifyBackupAtRuntime(this.config, input);
  }

  private checkpointSqliteBeforeBackup(): void {
    try {
      this.gatewaySql.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (error) {
      throw new Error(`failed to checkpoint sqlite before backup: ${(error as Error).message}`, {
        cause: error,
      });
    }
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
    const sortedBackups = backupEntries
      .filter((entry) => entry.isFile())
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const removableBackups = sortedBackups.slice(Math.max(0, policy.backupsKeep));
    const removedBackupFiles = removableBackups.length;
    reclaimedBytes += removableBackups.reduce((sum, file) => sum + file.size, 0);
    if (!dryRun) {
      for (const file of removableBackups) {
        await fs.rm(path.join(backupDir, file.name), { force: true });
      }
    }

    if (policy.transcriptsDays !== undefined) {
      const transcriptsDir = path.resolve(this.config.rootDir, this.config.assistant.transcriptsDir);
      const cutoff = Date.now() - policy.transcriptsDays * 24 * 60 * 60 * 1000;
      const pruned = await pruneFilesOlderThan(transcriptsDir, cutoff, dryRun);
      removedTranscriptFiles = pruned.files;
      reclaimedBytes += pruned.bytes;
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
      paths.add(path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/"));
      paths.add(`${path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/")}-wal`);
      paths.add(`${path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/")}-shm`);
      paths.add(this.config.assistant.transcriptsDir.replaceAll("\\", "/"));
      paths.add(this.config.assistant.auditDir.replaceAll("\\", "/"));
    }
    paths.add("config");
    return [...paths];
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

function resolveBackupDirectory(): string {
  const fromEnv = process.env.GOATCITADEL_BACKUP_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".GoatCitadel", "backups");
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
    mtimeMs: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>
> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: Array<{
      name: string;
      size: number;
      mtimeMs: number;
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
        mtimeMs: stats.mtimeMs,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
      });
    }
    return result;
  } catch {
    return [];
  }
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

async function copyPathIfExists(source: string, target: string): Promise<void> {
  let stats: fsSync.Stats;
  try {
    stats = await fs.stat(source);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true });
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
  return connectionString.replace("@127.0.0.1:55432/", "@127.0.0.1:5432/");
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
