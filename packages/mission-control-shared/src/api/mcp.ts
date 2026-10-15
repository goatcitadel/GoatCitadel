import type { McpServerRecord, McpServerTemplateRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchMcpServers(): Promise<{ items: McpServerRecord[] }> {
  return request<{ items: McpServerRecord[] }>("/api/v1/mcp/servers", { cache: "no-store" });
}

export async function fetchMcpTemplates(): Promise<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }> {
  return request<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }>("/api/v1/mcp/templates");
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchMcpServer,
  fetchMcpServerTestEvidence,
  fetchMcpTemplateDiscovery,
  fetchMcpRemotePreview,
  fetchMcpServerModeManifest,
  fetchMcpElicitations,
  createMcpElicitation,
  respondMcpElicitation,
  callMcpServerModePreview,
  createMcpServer,
  updateMcpServer,
  updateMcpServerPolicy,
  deleteMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  connectReviewedMcpServer,
  disconnectReviewedMcpServer,
  startMcpOAuth,
  startReviewedMcpOAuth,
  completeReviewedMcpOAuth,
  completeMcpOAuth,
  fetchMcpTools,
  invokeMcpTool,
  runMcpServerHealthCheck,
} from "./mcp-operations.js";
