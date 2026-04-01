import fs from "node:fs/promises";
import path from "node:path";
import { getRequestAttribution } from "./request-attribution.js";

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
    let line: string;
    try {
      line = JSON.stringify(baseRecord) + "\n";
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
