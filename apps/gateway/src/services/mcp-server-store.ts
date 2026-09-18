import { writeMcpServerConfiguration, reserveMcpOAuthRequest } from "./mcp-server-configuration-service.js";
import { readMcpServers, readMcpAuthState, readMcpEnvironmentBinding, readMcpFirstApprovals } from "./mcp-server-read-service.js";
import { mutateMcpServerRegistry } from "./mcp-server-registry-mutation.js";
import { completeMcpConnection, readMcpToolInventory, writeMcpToolInventory } from "./mcp-tool-inventory-service.js";
import { McpServerStateRemovalService } from "./mcp-server-state-removal-service.js";
import { publishMcpEnvironmentBinding } from "./mcp-environment-publication-service.js";
import { assertConfigurationSnapshot, GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-state-helpers.js";
import { publishMcpAuthState } from "./mcp-auth-publication-service.js";
import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  resolveMcpServerConnectionMode,
  type McpServerRecord,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type {
  McpAuthStateRecord,
  McpAuthStateUpdate,
  McpOAuthRequestReservation,
  McpOAuthTokenRequest,
} from "./mcp-server-admin-service.js";
import { type McpEnvironmentBindingRecord } from "./mcp-static-environment-service.js";
import type { McpCredentialRetirementStore, McpCredentialDelete } from "./mcp-credential-retirement-store.js";
import type { McpCredentialStagingStore, McpCredentialWriteProbe } from "./mcp-credential-staging-store.js";
import { createMcpCredentialStores } from "./mcp-credential-store-composition.js";
import { mcpServerRevision, newMcpServerRevision, type McpServerWriteReview } from "./mcp-server-revision.js";


/**
 * Server ids the gateway itself owns and synthesizes at read time; they are never
 * persisted and callers cannot register or overwrite them.
 */
export { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-state-helpers.js";

export interface McpServerStoreCtx {
  systemSettings: Pick<Storage["systemSettings"], "get" | "set" | "compareAndSet">;
  runImmediateTransaction: Storage["runImmediateTransaction"];
  /** Production composition supplies the same transaction-bound approval owner. */
  approvalInbox?: Pick<Storage["approvalInbox"], "deleteByReceiver">;
}

/**
 * Owns the system-settings-backed MCP registry: persisted caller servers/tools
 * plus the synthesized gateway-owned internal servers, MCP auth state, and the
 * first-use tool approvals. Extracted from GatewayService (B5a).
 */
export class McpServerStore {
  private readonly credentialRetirements: McpCredentialRetirementStore;
  private readonly credentialStaging: McpCredentialStagingStore;
  private readonly stateRemoval: McpServerStateRemovalService;
  constructor(private readonly ctx: McpServerStoreCtx) {
    const credentials = createMcpCredentialStores(ctx);
    this.credentialRetirements = credentials.credentialRetirements;
    this.credentialStaging = credentials.credentialStaging;
    this.stateRemoval = new McpServerStateRemovalService(ctx, this.credentialRetirements);
  }

  async stageCredentialVersions(serverId: string, refs: readonly string[], write: (writeId?: string) => undefined, custodyId: string | null = null): Promise<void> {
    await this.credentialStaging.write(serverId, refs, write, custodyId);
  }

  async reconcileCredentialStaging(limit = 32, probe?: McpCredentialWriteProbe) {
    return this.credentialStaging.reconcile(limit, probe);
  }

  async reconcileCredentialRetirements(deleteSecret: McpCredentialDelete, limit = 32) {
    return this.credentialRetirements.reconcile(deleteSecret, limit);
  }

  async readServers(): Promise<McpServerRecord[]> {
    return readMcpServers(this.ctx);
  }

  async writeServers(servers: McpServerRecord[], expectedServers: McpServerRecord[], review?: McpServerWriteReview): Promise<McpServerRecord[]> {
    return writeMcpServerConfiguration(this.ctx, {
      mutateServers: (update) => this.mutateServers(update),
      removeServerState: (ids) => this.removeServerState(ids),
      removeFirstApprovals: (ids) => this.removeFirstApprovals(ids),
      removeTools: (ids) => this.removeTools(ids),
      readAuthState: () => this.readAuthState(),
    }, servers, expectedServers, review);
  }

  /** Issues legacy configuration identity explicitly; ordinary inventory reads stay read-only. */
  async ensureStaticConfigurationBinding(serverId: string): Promise<McpServerRecord> {
    const servers = await this.mutateServers((current) => {
      const server = current.find((item) => item.serverId === serverId);
      if (!server) throw new Error(`Unknown caller-owned MCP server: ${serverId}`);
      if (resolveMcpServerConnectionMode(server) !== "static") {
        throw new ConflictError({ message: "MCP server does not use static configuration." });
      }
      return current.map((item) =>
        item.serverId === serverId
          ? { ...item, configurationBindingId: item.configurationBindingId ?? randomUUID(), revision: item.configurationBindingId ? item.revision : newMcpServerRevision() }
          : item,
      );
    });
    return servers.find((server) => server.serverId === serverId)!;
  }

  private async mutateServers(update: (current: McpServerRecord[]) => McpServerRecord[]): Promise<McpServerRecord[]> {
    return mutateMcpServerRegistry(this.ctx, update);
  }

  async requireServer(serverId: string): Promise<McpServerRecord> {
    const server = (await this.readServers()).find((item) => item.serverId === serverId);
    if (!server) {
      throw new NotFoundError(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  async patchServerState(
    serverId: string,
    patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>,
    expected?: McpServerRecord,
  ): Promise<McpServerRecord> {
    const now = new Date().toISOString();
    const hasStatus = Object.prototype.hasOwnProperty.call(patch, "status");
    const hasLastConnectedAt = Object.prototype.hasOwnProperty.call(patch, "lastConnectedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(patch, "lastError");
    const applyPatch = (item: McpServerRecord): McpServerRecord => ({
      ...item,
      status: hasStatus ? (patch.status ?? item.status) : item.status,
      lastConnectedAt: hasLastConnectedAt ? patch.lastConnectedAt : item.lastConnectedAt,
      lastError: hasLastError ? patch.lastError : item.lastError,
      updatedAt: now,
      revision: mcpServerRevision(item),
      connectionRevision: newMcpServerRevision(),
    });
    if (GATEWAY_OWNED_MCP_SERVER_IDS.has(serverId)) return applyPatch(await this.requireServer(serverId));
    let updated: McpServerRecord | undefined;
    await this.mutateServers((current) => {
      const target = current.find((item) => item.serverId === serverId);
      if (!target) throw new NotFoundError(`Unknown MCP server: ${serverId}`);
      if (expected) assertConnectionSnapshot(target, expected);
      updated = applyPatch(target);
      return current.map((item) => (item.serverId === serverId ? updated! : item));
    });
    if (!updated) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return updated;
  }

  /** The registry lock fences the attempt and serializes its cache replacement with edits/deletes. */
  async completeConnection(expected: McpServerRecord, tools: McpToolRecord[]): Promise<McpServerRecord> {
    return completeMcpConnection(this.ctx, {
      patchServerState: (serverId, patch, observed) => this.patchServerState(serverId, patch, observed),
    }, expected, tools);
  }

  async readTools(): Promise<McpToolRecord[]> {
    return readMcpToolInventory(this.ctx);
  }

  async writeTools(tools: McpToolRecord[]): Promise<void> {
    return writeMcpToolInventory(this.ctx, tools);
  }

  async readAuthState(): Promise<Record<string, McpAuthStateRecord>> {
    return readMcpAuthState(this.ctx);
  }

  async reserveAuthRequest(
    server: McpServerRecord,
    expected: McpAuthStateRecord | undefined,
    kind: McpOAuthTokenRequest["kind"],
  ): Promise<McpOAuthRequestReservation> {
    return reserveMcpOAuthRequest(this.ctx, {
      requireServer: (id) => this.requireServer(id),
      ensureStaticConfigurationBinding: (id) => this.ensureStaticConfigurationBinding(id),
      writeAuthState: (input) => this.writeAuthState(input),
    }, server, expected, kind);
  }

  async writeAuthState(input: McpAuthStateUpdate): Promise<void> {
    await publishMcpAuthState(this.ctx, {
      credentialRetirements: this.credentialRetirements,
      credentialStaging: this.credentialStaging,
      removeFirstApprovals: (serverIds) => this.removeFirstApprovals(serverIds),
    }, input);
  }

  async readEnvironmentBinding(serverId: string): Promise<McpEnvironmentBindingRecord | undefined> {
    return readMcpEnvironmentBinding(this.ctx, serverId);
  }

  async writeEnvironmentBinding(
    server: McpServerRecord,
    expected: McpEnvironmentBindingRecord | undefined,
    next: McpEnvironmentBindingRecord | undefined,
  ): Promise<McpServerRecord> {
    return publishMcpEnvironmentBinding(this.ctx, {
      credentialRetirements: this.credentialRetirements,
      credentialStaging: this.credentialStaging,
      removeAuthState: (serverIds) => this.removeAuthState(serverIds),
      removeFirstApprovals: (serverIds) => this.removeFirstApprovals(serverIds),
    }, server, expected, next);
  }

  private async removeAuthState(serverIds: string[]): Promise<void> {
    return this.stateRemoval.removeAuthState(serverIds);
  }

  private async removeServerState(serverIds: string[]): Promise<void> {
    return this.stateRemoval.removeServerState(serverIds);
  }

  private async removeTools(serverIds: string[]): Promise<void> {
    return this.stateRemoval.removeTools(serverIds);
  }

  private async removeFirstApprovals(serverIds: string[]): Promise<void> {
    return this.stateRemoval.removeFirstApprovals(serverIds);
  }

  async readFirstApprovals(): Promise<Record<string, string[]>> {
    return readMcpFirstApprovals(this.ctx);
  }

  async isToolApproved(serverId: string, toolName: string): Promise<boolean> {
    const approved = await this.readFirstApprovals();
    return approved[serverId]?.includes(toolName) ?? false;
  }
}

function assertConnectionSnapshot(current: McpServerRecord, expected: McpServerRecord): void {
  assertConfigurationSnapshot([current], [expected]);
  if (current.connectionRevision !== expected.connectionRevision) {
    throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP connection attempt was superseded; its late result was not applied." });
  }
}
