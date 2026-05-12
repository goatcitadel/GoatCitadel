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

export type AuditStream = "tool_invocations" | "policy_blocks" | "approvals" | "hooks";

export class AuditLog {
  public constructor(private readonly auditDir: string) {}

  public async append(stream: AuditStream, payload: Record<string, unknown>): Promise<void> {
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
    await pruneAuditStreamIfNeeded(filePath);
    await fs.appendFile(filePath, line, { encoding: "utf8" });
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
}

async function pruneAuditStreamIfNeeded(filePath: string): Promise<void> {
  const retentionDays = getConfiguredRetentionDays();
  if (retentionDays === undefined) {
    return;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
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
    return;
  }

  const nextContent = retainedLines.length > 0 ? `${normalizedRetained}\n` : "";
  await fs.writeFile(filePath, nextContent, "utf8");
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
