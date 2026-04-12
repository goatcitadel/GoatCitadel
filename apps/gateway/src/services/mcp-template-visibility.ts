import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";

export function isVisibleMcpTemplateRecord(template: Pick<McpServerTemplateRecord, "transport" | "url">): boolean {
  return template.transport === "stdio" || template.url?.trim().toLowerCase() === MCP_APPROVAL_INBOX_URL;
}
