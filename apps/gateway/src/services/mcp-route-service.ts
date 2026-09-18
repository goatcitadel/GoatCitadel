import type {
  ConnectorDiagnosticReport,
  McpInvokeRequest,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpServerCreateInput,
  McpServerPolicyUpdateRequest,
  McpServerRecord,
  McpServerTemplateRecord,
  McpServerUpdateRequest,
  McpTemplateDiscoveryResult,
  McpToolRecord,
} from "@goatcitadel/contracts";
import type { McpElicitationService } from "./mcp-elicitation-service.js";
import { preserveMcpServerSecretsForPublicUpdate, projectMcpPublicValue } from "./mcp-public-projection.js";
import { NotFoundError } from "@goatcitadel/contracts";
import { assertMcpServerReview } from "./mcp-server-revision.js";

export interface McpRoutePort {
  /** Shared MCP elicitation store, also consumed by the approval-inbox respond/list tools. */
  readonly elicitations: McpElicitationService;
  completeMcpOAuth(serverId: string, code: string, state?: string): Promise<McpServerRecord>;
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  createMcpServer(input: McpServerCreateInput, onCommitted?: () => void | Promise<void>): Promise<McpServerRecord>;
  deleteMcpServer(serverId: string, expectedRevision: string, onCommitted?: () => void | Promise<void>): Promise<{ deleted: boolean }>;
  disconnectMcpServer(serverId: string): Promise<McpServerRecord>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
  listMcpServers(): Promise<McpServerRecord[]>;
  listMcpTemplateDiscovery(): Promise<McpTemplateDiscoveryResult[]>;
  listMcpTemplates(): Promise<Array<McpServerTemplateRecord & { installed: boolean }>>;
  listMcpTools(serverId: string): Promise<McpToolRecord[]>;
  runMcpServerHealthCheck(serverId: string): Promise<ConnectorDiagnosticReport>;
  startMcpOAuth(serverId: string): Promise<McpOAuthStartResponse>;
  updateMcpServer(serverId: string, input: McpServerUpdateRequest, onCommitted?: () => void | Promise<void>): Promise<McpServerRecord>;
  updateMcpServerPolicy(serverId: string, policy: McpServerPolicyUpdateRequest, onCommitted?: () => void | Promise<void>): Promise<McpServerRecord>;
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

  public async getMcpServer(serverId: string) {
    return projectMcpPublicValue(await this.requireServer(serverId));
  }

  private async requireServer(serverId: string) {
    const current = (await this.mcp.listMcpServers()).find((server) => server.serverId === serverId);
    if (!current) throw new NotFoundError(`Unknown MCP server: ${serverId}`);
    return current;
  }

  public async listMcpTemplates() {
    return projectMcpPublicValue(await this.mcp.listMcpTemplates());
  }

  public async listMcpTemplateDiscovery() {
    return projectMcpPublicValue(await this.mcp.listMcpTemplateDiscovery());
  }

  public async createMcpServer(input: McpServerCreateInput, onCommitted?: () => void | Promise<void>) {
    return projectMcpPublicValue(await this.mcp.createMcpServer(input, onCommitted));
  }

  public async updateMcpServer(serverId: string, input: McpServerUpdateRequest, onCommitted?: () => void | Promise<void>) {
    const current = await this.requireServer(serverId);
    assertMcpServerReview(current, input.expectedRevision);
    const reconciled = preserveMcpServerSecretsForPublicUpdate(current, input);
    return projectMcpPublicValue(await this.mcp.updateMcpServer(serverId, { ...reconciled, expectedRevision: input.expectedRevision }, onCommitted));
  }

  public async deleteMcpServer(serverId: string, expectedRevision: string, onCommitted?: () => void | Promise<void>) {
    return await this.mcp.deleteMcpServer(serverId, expectedRevision, onCommitted);
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

  public async updateMcpServerPolicy(serverId: string, input: McpServerPolicyUpdateRequest, onCommitted?: () => void | Promise<void>) {
    const current = await this.requireServer(serverId);
    const { expectedRevision, ...policy } = input;
    assertMcpServerReview(current, expectedRevision);
    const reconciled = preserveMcpServerSecretsForPublicUpdate(current, { policy }).policy ?? policy;
    return projectMcpPublicValue(await this.mcp.updateMcpServerPolicy(serverId, { ...reconciled, expectedRevision }, onCommitted));
  }

  public async runMcpServerHealthCheck(serverId: string) {
    return projectMcpPublicValue(await this.mcp.runMcpServerHealthCheck(serverId));
  }
}
