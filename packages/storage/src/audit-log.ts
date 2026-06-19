import fs from "node:fs/promises";
import path from "node:path";
import { getRequestAttribution } from "./request-attribution.js";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  /\bkey-[a-zA-Z0-9]{20,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/g,
  /\b(?:Authorization|Proxy-Authorization):\s*(?:Bearer|Basic)\s+[^\s,;]+/gi,
  /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|signature)=)[^&#\s]+/gi,
  /\b[A-Z][A-Z0-9_]{2,}=\S{16,}\b/g,
  /\bkeychain:[^\s"']+\b/g,
];

const SECRET_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd|token|signature)$/i;
const ARGV_LIKE_KEY_PATTERN = /^(?:argv|args|execArgv|commandArgs|command_argv)$/i;
const SECRET_ARG_FLAG_PATTERN =
  /^--?(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|authorization|proxy-authorization)(?:=|$)/i;
const AUDIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const AUDIT_FILE_LOCK_SUFFIX = ".lock";
const AUDIT_FILE_LOCK_RETRY_MS = 25;
const AUDIT_FILE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const AUDIT_FILE_LOCK_STALE_MS = 60_000;

export type AuditStream = "tool_invocations" | "policy_blocks" | "approvals" | "hooks";

export class AuditLog {
  private readonly streamLocks = new Map<string, Promise<void>>();
  private readonly writeQueues = new Map<AuditStream, Promise<void>>();
  private readonly lastPrunedAt = new Map<AuditStream, number>();

  public constructor(private readonly auditDir: string) {}

  public async append(stream: AuditStream, payload: Record<string, unknown>): Promise<void> {
    const prior = this.writeQueues.get(stream) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => this.appendInternal(stream, payload));
    this.writeQueues.set(stream, next);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(stream) === next) {
        this.writeQueues.delete(stream);
      }
    }
  }

  private async appendInternal(stream: AuditStream, payload: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.auditDir, `${stream}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const attribution = getRequestAttribution();
    const baseRecord = {
      timestamp: new Date().toISOString(),
      ...payload,
      correlationId: payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
      companionSessionId: payload.companionSessionId ?? attribution?.companionSessionId,
    };
    const sanitizedRecord = sanitizeForAudit(baseRecord);
    let line: string;
    try {
      line = JSON.stringify(sanitizedRecord) + "\n";
    } catch (error) {
      // eslint-disable-next-line no-console -- degraded audit serialization should still surface in local runtime logs.
      console.warn("[goatcitadel] audit log payload could not be serialized; writing degraded record", {
        stream,
        error: error instanceof Error ? error.message : String(error),
      });
      line =
        JSON.stringify({
          timestamp: baseRecord.timestamp,
          correlationId: baseRecord.correlationId,
          traceId: baseRecord.traceId,
          originSurface: baseRecord.originSurface,
          actorId: baseRecord.actorId,
          deviceId: baseRecord.deviceId,
          grantId: baseRecord.grantId,
          companionSessionId: baseRecord.companionSessionId,
          serializationError: error instanceof Error ? error.message : String(error),
          degraded: true,
        }) + "\n";
    }
    await this.runWithStreamLock(filePath, async () => {
      await this.pruneAuditStreamIfDue(stream, filePath);
      await fs.appendFile(filePath, line, { encoding: "utf8" });
    });
  }

  public async list(stream: AuditStream): Promise<Record<string, unknown>[]> {
    const filePath = path.join(this.auditDir, `${stream}.jsonl`);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  }

  private async runWithStreamLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.streamLocks.get(filePath) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.streamLocks.set(filePath, next);

    await previous.catch(() => undefined);
    try {
      return await runWithAuditFileLock(filePath, operation);
    } finally {
      release();
      if (this.streamLocks.get(filePath) === next) {
        this.streamLocks.delete(filePath);
      }
    }
  }

  private async pruneAuditStreamIfDue(stream: AuditStream, filePath: string): Promise<void> {
    const now = Date.now();
    const lastPrunedAt = this.lastPrunedAt.get(stream) ?? 0;
    if (now - lastPrunedAt < AUDIT_PRUNE_INTERVAL_MS) {
      return;
    }
    const attempted = await pruneAuditStreamIfNeeded(filePath);
    if (attempted) {
      this.lastPrunedAt.set(stream, now);
    }
  }
}

async function runWithAuditFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockDir = `${filePath}${AUDIT_FILE_LOCK_SUFFIX}`;
  await acquireAuditFileLock(lockDir);
  try {
    return await operation();
  } finally {
    await releaseAuditFileLock(lockDir);
  }
}

async function acquireAuditFileLock(lockDir: string): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await writeAuditLockOwner(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleAuditFileLock(lockDir)) {
        continue;
      }
      if (Date.now() - startedAt >= AUDIT_FILE_LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new Error(
          `Timed out acquiring audit log file lock for ${path.basename(lockDir, AUDIT_FILE_LOCK_SUFFIX)}.`,
          {
            cause: error,
          },
        );
      }
      await sleep(AUDIT_FILE_LOCK_RETRY_MS);
    }
  }
}

async function writeAuditLockOwner(lockDir: string): Promise<void> {
  try {
    await fs.appendFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch {
    // The directory creation is the lock. Owner metadata is best-effort only.
  }
}

async function removeStaleAuditFileLock(lockDir: string): Promise<boolean> {
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (Date.now() - stat.mtimeMs < AUDIT_FILE_LOCK_STALE_MS) {
    return false;
  }
  await releaseAuditFileLock(lockDir);
  return true;
}

async function releaseAuditFileLock(lockDir: string): Promise<void> {
  await fs.rm(lockDir, { recursive: true, force: true });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pruneAuditStreamIfNeeded(filePath: string): Promise<boolean> {
  const retentionDays = getConfiguredRetentionDays();
  if (retentionDays === undefined) {
    return false;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const retainedLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => shouldRetainAuditLine(line, cutoffMs));

  const normalizedExisting = content.trim();
  const normalizedRetained = retainedLines.join("\n");
  if (normalizedExisting === normalizedRetained) {
    return true;
  }

  const nextContent = retainedLines.length > 0 ? `${normalizedRetained}\n` : "";
  await fs.writeFile(filePath, nextContent, "utf8");
  return true;
}

function shouldRetainAuditLine(line: string, cutoffMs: number): boolean {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    if (typeof parsed.timestamp !== "string") {
      return true;
    }
    const timestampMs = Date.parse(parsed.timestamp);
    return Number.isNaN(timestampMs) || timestampMs >= cutoffMs;
  } catch {
    return true;
  }
}

function getConfiguredRetentionDays(): number | undefined {
  const raw = process.env.GOAT_AUDIT_RETENTION_DAYS?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

export function sanitizeForAudit<T>(value: T): T {
  return sanitizeForAuditInternal(value, new WeakSet<object>());
}

function sanitizeForAuditInternal<T>(value: T, seen: WeakSet<object>, key?: string): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (Array.isArray(value)) {
    return sanitizeArrayForAudit(value, seen, key) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]" as T;
  }
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = shouldRedactAuditKey(key) ? "[REDACTED]" : sanitizeForAuditInternal(entry, seen, key);
  }
  return output as T;
}

function sanitizeArrayForAudit(value: unknown[], seen: WeakSet<object>, key?: string): unknown[] {
  if (!key || !ARGV_LIKE_KEY_PATTERN.test(key)) {
    return value.map((entry) => sanitizeForAuditInternal(entry, seen));
  }

  let redactNext = false;
  return value.map((entry) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (typeof entry !== "string") {
      return sanitizeForAuditInternal(entry, seen);
    }
    if (SECRET_ARG_FLAG_PATTERN.test(entry)) {
      const equalsIndex = entry.indexOf("=");
      if (equalsIndex >= 0) {
        return `${entry.slice(0, equalsIndex + 1)}[REDACTED]`;
      }
      redactNext = true;
      return entry;
    }
    return sanitizeString(entry);
  });
}

function shouldRedactAuditKey(key: string): boolean {
  if (/env$/i.test(key)) {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function sanitizeString(value: string): string {
  let scrubbed = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, (...match) => {
      const prefix = typeof match[1] === "string" ? match[1] : "";
      return prefix ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return scrubbed;
}
