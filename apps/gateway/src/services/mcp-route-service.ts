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
import { preserveMcpServerSecretsForPublicUpdate, projectMcpPublicValue } from "./mcp-public-projection.js";

export interface McpRoutePort {
  /** Shared MCP elicitation store, also consumed by the approval-inbox respond/list tools. */
  readonly elicitations: McpElicitationService;
  completeMcpOAuth(serverId: string, code: string, state?: string): Promise<McpServerRecord>;
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  createMcpServer(input: McpServerCreateInput): Promise<McpServerRecord>;
  deleteMcpServer(serverId: string): Promise<{ deleted: boolean }>;
  disconnectMcpServer(serverId: string): Promise<McpServerRecord>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
  listMcpServers(): Promise<McpServerRecord[]>;
  listMcpTemplateDiscovery(): Promise<McpTemplateDiscoveryResult[]>;
  listMcpTemplates(): Promise<Array<McpServerTemplateRecord & { installed: boolean }>>;
  listMcpTools(serverId: string): Promise<McpToolRecord[]>;
  runMcpServerHealthCheck(serverId: string): Promise<ConnectorDiagnosticReport>;
  startMcpOAuth(serverId: string): Promise<McpOAuthStartResponse>;
  updateMcpServer(serverId: string, input: McpServerUpdateInput): Promise<McpServerRecord>;
  updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>): Promise<McpServerRecord>;
}

export type McpAdminPort = McpRoutePort;

export class McpRouteService {
  public constructor(private readonly mcp: McpRoutePort) {}

  /** Shared MCP elicitation store, consumed by both the HTTP route and approval-inbox tools. */
  public get elicitations() {
    return this.mcp.elicitations;
  }

  public async listMcpServers() {
    return projectMcpPublicValue(await this.mcp.listMcpServers());
  }

  public async listMcpTemplates() {
    return projectMcpPublicValue(await this.mcp.listMcpTemplates());
  }

  public async listMcpTemplateDiscovery() {
    return projectMcpPublicValue(await this.mcp.listMcpTemplateDiscovery());
  }

  public async createMcpServer(input: McpServerCreateInput) {
    return projectMcpPublicValue(await this.mcp.createMcpServer(input));
  }

  public async updateMcpServer(serverId: string, input: McpServerUpdateInput) {
    const current = (await this.mcp.listMcpServers()).find((server) => server.serverId === serverId);
    const reconciled = current ? preserveMcpServerSecretsForPublicUpdate(current, input) : input;
    return projectMcpPublicValue(await this.mcp.updateMcpServer(serverId, reconciled));
  }

  public async deleteMcpServer(serverId: string) {
    return await this.mcp.deleteMcpServer(serverId);
  }

  public connectMcpServer(serverId: string) {
    return this.mcp.connectMcpServer(serverId).then(projectMcpPublicValue);
  }

  public async disconnectMcpServer(serverId: string) {
    return projectMcpPublicValue(await this.mcp.disconnectMcpServer(serverId));
  }

  public async startMcpOAuth(serverId: string) {
    return await this.mcp.startMcpOAuth(serverId);
  }

  public completeMcpOAuth(serverId: string, code: string, state?: string) {
    return this.mcp.completeMcpOAuth(serverId, code, state).then(projectMcpPublicValue);
  }

  public async listMcpTools(serverId: string) {
    return projectMcpPublicValue(await this.mcp.listMcpTools(serverId));
  }

  public invokeMcpTool(input: McpInvokeRequest) {
    return this.mcp.invokeMcpTool(input).then(projectMcpPublicValue);
  }

  public async updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>) {
    const current = (await this.mcp.listMcpServers()).find((server) => server.serverId === serverId);
    const reconciled = current
      ? (preserveMcpServerSecretsForPublicUpdate(current, { policy }).policy ?? policy)
      : policy;
    return projectMcpPublicValue(await this.mcp.updateMcpServerPolicy(serverId, reconciled));
  }

  public async runMcpServerHealthCheck(serverId: string) {
    return projectMcpPublicValue(await this.mcp.runMcpServerHealthCheck(serverId));
  }
}
