import fs from "node:fs/promises";
import path from "node:path";
import { getRequestAttribution } from "./request-attribution.js";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  /\bkey-[a-zA-Z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
  /\b[A-Z][A-Z0-9_]{2,}=\S{16,}\b/g,
  /\bkeychain:[^\s"']+\b/g,
];

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
      console.warn("[goatcitadel] audit log payload could not be serialized; writing degraded record", {
        stream,
        error: error instanceof Error ? error.message : String(error),
      });
      line = JSON.stringify({
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
          return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
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

  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
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

function sanitizeForAudit<T>(value: T): T {
  return sanitizeForAuditInternal(value, new WeakSet<object>());
}

function sanitizeForAuditInternal<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForAuditInternal(entry, seen)) as T;
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
    output[key] = sanitizeForAuditInternal(entry, seen);
  }
  return output as T;
}

function sanitizeString(value: string): string {
  let scrubbed = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}
