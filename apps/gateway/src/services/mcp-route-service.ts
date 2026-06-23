import type {
  ConnectorDiagnosticReport,
  McpInvokeRequest,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerRecord,
  McpServerTemplateRecord,
  McpServerUpdateInput,
  McpTemplateDiscoveryResult,
  McpToolRecord,
} from "@goatcitadel/contracts";
import type { McpElicitationService } from "./mcp-elicitation-service.js";

export interface McpRoutePort {
  /** Shared MCP elicitation store, also consumed by the approval-inbox respond/list tools. */
  readonly elicitations: McpElicitationService;
  completeMcpOAuth(serverId: string, code: string, state?: string): Promise<McpServerRecord>;
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  createMcpServer(input: McpServerCreateInput): McpServerRecord;
  deleteMcpServer(serverId: string): { deleted: boolean };
  disconnectMcpServer(serverId: string): McpServerRecord;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
  listMcpServers(): McpServerRecord[];
  listMcpTemplateDiscovery(): McpTemplateDiscoveryResult[];
  listMcpTemplates(): Array<McpServerTemplateRecord & { installed: boolean }>;
  listMcpTools(serverId: string): McpToolRecord[];
  runMcpServerHealthCheck(serverId: string): ConnectorDiagnosticReport;
  startMcpOAuth(serverId: string): McpOAuthStartResponse;
  updateMcpServer(serverId: string, input: McpServerUpdateInput): McpServerRecord;
  updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>): McpServerRecord;
}

export type McpAdminPort = McpRoutePort;

export class McpRouteService {
  public constructor(private readonly mcp: McpRoutePort) {}

  /** Shared MCP elicitation store, consumed by both the HTTP route and approval-inbox tools. */
  public get elicitations() {
    return this.mcp.elicitations;
  }

  public listMcpServers() {
    return this.mcp.listMcpServers();
  }

  public listMcpTemplates() {
    return this.mcp.listMcpTemplates();
  }

  public listMcpTemplateDiscovery() {
    return this.mcp.listMcpTemplateDiscovery();
  }

  public createMcpServer(input: McpServerCreateInput) {
    return this.mcp.createMcpServer(input);
  }

  public updateMcpServer(serverId: string, input: McpServerUpdateInput) {
    return this.mcp.updateMcpServer(serverId, input);
  }

  public deleteMcpServer(serverId: string) {
    return this.mcp.deleteMcpServer(serverId);
  }

  public connectMcpServer(serverId: string) {
    return this.mcp.connectMcpServer(serverId);
  }

  public disconnectMcpServer(serverId: string) {
    return this.mcp.disconnectMcpServer(serverId);
  }

  public startMcpOAuth(serverId: string) {
    return this.mcp.startMcpOAuth(serverId);
  }

  public completeMcpOAuth(serverId: string, code: string, state?: string) {
    return this.mcp.completeMcpOAuth(serverId, code, state);
  }

  public listMcpTools(serverId: string) {
    return this.mcp.listMcpTools(serverId);
  }

  public invokeMcpTool(input: McpInvokeRequest) {
    return this.mcp.invokeMcpTool(input);
  }

  public updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>) {
    return this.mcp.updateMcpServerPolicy(serverId, policy);
  }

  public runMcpServerHealthCheck(serverId: string) {
    return this.mcp.runMcpServerHealthCheck(serverId);
  }
}
