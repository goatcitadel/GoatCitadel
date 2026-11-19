import { randomUUID } from "node:crypto";
import {
  ConflictError,
  ValidationError,
  type McpServerRecord,
  type McpTestAllowance,
  type McpTestAllowanceCandidate,
  type McpTestAllowanceRequest,
  type McpTestAllowanceStatus,
  type McpToolRecord,
  type ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import { isConnectedStaticServer } from "./mcp-static-profile-authority.js";

const ALLOWANCE_TTL_MS = 5 * 60_000;

interface FixturePort {
  available(): boolean;
  readServers(): Promise<McpServerRecord[]>;
  readTools(): Promise<McpToolRecord[]>;
  readSession(id: string): Promise<{ workspaceId: string; lifecycleStatus: "active" | "archived" } | undefined>;
}

function fixtureCandidate(
  server: McpServerRecord,
  inventory: readonly McpToolRecord[],
): McpTestAllowanceCandidate | undefined {
  const [tool, extra] = inventory;
  if (
    !isConnectedStaticServer(server) ||
    !server.revision ||
    !server.connectionRevision ||
    server.transport !== "http" ||
    !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp$/u.test(server.url ?? "") ||
    server.authType !== "none" ||
    server.trustTier !== "restricted" ||
    !server.policy.requireFirstToolApproval ||
    server.policy.allowedToolPatterns.length !== 1 ||
    !tool ||
    extra ||
    !tool.enabled ||
    !/^[a-zA-Z0-9_-]{1,100}$/u.test(tool.toolName) ||
    server.policy.allowedToolPatterns[0] !== tool.toolName ||
    tool.annotations?.readOnlyHint !== true ||
    tool.annotations?.destructiveHint !== false
  )
    return undefined;
  return {
    serverId: server.serverId,
    serverRevision: server.revision,
    connectionRevision: server.connectionRevision,
    label: server.label,
    toolName: tool.toolName,
  };
}

/** The test allowance is process-local, expires automatically, and never writes tool policy. */
export class LocalMcpFixtureTestService {
  private active?: Readonly<McpTestAllowance & { actorId: string }>;

  public constructor(private readonly port: FixturePort) {}

  public async status(actorId: string): Promise<McpTestAllowanceStatus> {
    if (!this.port.available()) return { available: false, candidates: [], allowance: null };
    const candidates = await this.candidates();
    const current = this.current();
    return {
      available: true,
      candidates,
      allowance: current?.actorId === actorId ? this.publicAllowance(current) : null,
    };
  }

  public async activate(actorId: string, input: McpTestAllowanceRequest): Promise<McpTestAllowance> {
    if (!this.port.available()) throw new ValidationError({ message: "Temporary MCP allowances are unavailable." });
    const [candidates, session] = await Promise.all([this.candidates(), this.port.readSession(input.sessionId)]);
    const eligible = candidates.some((candidate) => this.matchesSelection(candidate, input));
    if (!eligible || session?.workspaceId !== input.workspaceId || session.lifecycleStatus !== "active") {
      throw new ValidationError({ message: "Choose an active Chat and a currently eligible read-only MCP connector." });
    }
    if (!this.port.available() || this.current()) {
      throw new ConflictError({
        message: "A temporary MCP allowance is already active or settings changed. Refresh and try again.",
      });
    }
    const allowance = {
      ...input,
      allowanceId: randomUUID(),
      expiresAt: new Date(Date.now() + ALLOWANCE_TTL_MS).toISOString(),
    };
    this.active = Object.freeze({ ...allowance, actorId });
    return allowance;
  }

  public revoke(actorId: string, allowanceId: string): boolean {
    const current = this.current();
    if (current?.actorId !== actorId || current.allowanceId !== allowanceId) return false;
    this.active = undefined;
    return true;
  }

  public async matches(request: ToolAccessEvaluateRequest, serverId: string): Promise<boolean> {
    const current = this.current();
    if (
      !current ||
      !this.port.available() ||
      request.sessionId !== current.sessionId ||
      request.workspaceId !== current.workspaceId ||
      (request.surface ?? request.policyContext?.surface) !== "chat" ||
      request.policyContext?.authActorSource !== "token" ||
      request.policyContext.authActorId !== current.actorId ||
      serverId !== current.serverId ||
      request.toolName !== `mcp.${current.serverId}.${current.toolName}` ||
      Object.keys(request.args ?? {}).length !== 0
    )
      return false;

    const [candidates, session] = await Promise.all([this.candidates(), this.port.readSession(current.sessionId)]);
    return (
      this.current() === current &&
      this.port.available() &&
      session?.workspaceId === current.workspaceId &&
      session.lifecycleStatus === "active" &&
      candidates.some((candidate) => this.matchesSelection(candidate, current))
    );
  }

  private current() {
    if (this.active && Date.now() >= Date.parse(this.active.expiresAt)) this.active = undefined;
    return this.active;
  }

  private async candidates(): Promise<McpTestAllowanceCandidate[]> {
    const [servers, tools] = await Promise.all([this.port.readServers(), this.port.readTools()]);
    const toolsByServer = new Map<string, McpToolRecord[]>();
    for (const tool of tools) {
      const inventory = toolsByServer.get(tool.serverId);
      if (inventory) inventory.push(tool);
      else toolsByServer.set(tool.serverId, [tool]);
    }
    return servers.flatMap((server) => {
      const candidate = fixtureCandidate(server, toolsByServer.get(server.serverId) ?? []);
      return candidate ? [candidate] : [];
    });
  }

  private matchesSelection(candidate: McpTestAllowanceCandidate, input: McpTestAllowanceRequest): boolean {
    return (
      candidate.serverId === input.serverId &&
      candidate.serverRevision === input.serverRevision &&
      candidate.connectionRevision === input.connectionRevision &&
      candidate.toolName === input.toolName
    );
  }

  private publicAllowance(current: McpTestAllowance & { actorId: string }): McpTestAllowance {
    const { actorId: _actorId, ...allowance } = current;
    return allowance;
  }
}
