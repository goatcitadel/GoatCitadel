import { createHash, randomBytes } from "node:crypto";
import { ConflictError, type McpServerRecord } from "@goatcitadel/contracts";

export interface McpServerWriteReview {
  serverId: string;
  expectedRevision: string;
}

export const newMcpServerRevision = () => randomBytes(32).toString("hex");

/** Legacy review identity contains no configuration or credential bytes. Every owner edit consumes it. */
export function mcpServerRevision(server: McpServerRecord): string {
  if (server.revision !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(server.revision)) throw mcpServerReviewConflict();
    return server.revision;
  }
  return createHash("sha256").update(`goatcitadel:mcp-edit:legacy:v1\0${server.serverId}`).digest("hex");
}

export function assertMcpServerReview(server: McpServerRecord, expectedRevision: string): void {
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision) || mcpServerRevision(server) !== expectedRevision) {
    throw mcpServerReviewConflict();
  }
}

export function mcpServerReviewConflict(): ConflictError {
  return new ConflictError({ code: "WRITE_CONFLICT", message: "MCP configuration changed; review the current server before applying this edit.", details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } });
}
