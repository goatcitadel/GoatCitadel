import fs from "node:fs/promises";
import path from "node:path";
import { getRequestAttribution } from "./request-attribution.js";

export type AuditStream = "tool_invocations" | "policy_blocks" | "approvals";

export class AuditLog {
  public constructor(private readonly auditDir: string) {}

  public async append(stream: AuditStream, payload: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.auditDir, `${stream}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const attribution = getRequestAttribution();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...payload,
      correlationId: payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
    }) + "\n";
    await fs.appendFile(filePath, line, { encoding: "utf8" });
  }
}
