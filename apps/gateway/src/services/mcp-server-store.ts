import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConflictError,
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
import { isMcpOAuthTokenRefForServer } from "./mcp-oauth-token-service.js";
import { MCP_APPROVAL_INBOX_URL, createInternalMcpApprovalInboxTools } from "./mcp-approval-inbox.js";
import { MCP_DURABLE_TASKS_URL, createInternalMcpDurableTasksTools } from "./mcp-durable-tasks.js";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { isMcpEnvironmentRefForServer, type McpEnvironmentBindingRecord } from "./mcp-static-environment-service.js";
import { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";

const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const MCP_ENVIRONMENT_SETTING_KEY = "mcp_environment_bindings_v1";
const GATEWAY_OWNED_MCP_CREATED_AT = "2026-05-26T00:00:00.000Z";

/**
 * Server ids the gateway itself owns and synthesizes at read time; they are never
 * persisted and callers cannot register or overwrite them.
 */
export const GATEWAY_OWNED_MCP_SERVER_IDS = new Set([
  "goatcitadel-internal-approval-inbox",
  "goatcitadel-internal-durable-tasks",
]);

export interface McpServerStoreCtx {
  systemSettings: Pick<Storage["systemSettings"], "get" | "set" | "compareAndSet">;
  runImmediateTransaction: Storage["runImmediateTransaction"];
}

/**
 * Owns the system-settings-backed MCP registry: persisted caller servers/tools
 * plus the synthesized gateway-owned internal servers, MCP auth state, and the
 * first-use tool approvals. Extracted from GatewayService (B5a).
 */
export class McpServerStore {
  private readonly credentialRetirements: McpCredentialRetirementStore;
  private readonly credentialStaging: McpCredentialStagingStore;
  constructor(private readonly ctx: McpServerStoreCtx) {
    this.credentialRetirements = new McpCredentialRetirementStore(ctx,
      (serverId, ref) => this.credentialStaging.readCustody(serverId, ref));
    this.credentialStaging = new McpCredentialStagingStore(ctx, this.credentialRetirements);
  }

  async stageCredentialVersions(serverId: string, refs: readonly string[], write: () => undefined, custodyId: string | null = null): Promise<void> {
    await this.credentialStaging.write(serverId, refs, write, custodyId);
  }

  async reconcileCredentialStaging(limit = 32) {
    return this.credentialStaging.reconcile(limit);
  }

  async reconcileCredentialRetirements(deleteSecret: (account: string, custodyId: string | null) => void | boolean | Promise<void | boolean>, limit = 32) {
    return this.credentialRetirements.reconcile(deleteSecret, limit);
  }

  async readServers(): Promise<McpServerRecord[]> {
    const [setting, authRows] = await Promise.all([
      this.ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY),
      this.readAuthState(),
    ]);
    const callerOwned = callerOwnedServers(setting?.value).map((item) => ({
      ...item,
      authState: buildPublicMcpAuthState(item, authRows[item.serverId]),
    }));
    return [...buildGatewayOwnedInternalMcpServers(authRows), ...callerOwned];
  }

  async writeServers(servers: McpServerRecord[], expectedServers: McpServerRecord[]): Promise<void> {
    if (!Array.isArray(expectedServers))
      throw new ConflictError({ message: "MCP configuration snapshot is required." });
    const desired = callerOwnedServers(structuredClone(servers));
    const expected = callerOwnedServers(structuredClone(expectedServers));
    assertUniqueServers(desired);
    assertUniqueServers(expected);
    await this.ctx.runImmediateTransaction(async () => {
      let removed: string[] = [];
      let invalidated: string[] = [];
      await this.mutateServers((current) => {
        assertConfigurationSnapshot(current, expected);
        invalidated = [];
        removed = current
          .filter((server) => !desired.some((item) => item.serverId === server.serverId))
          .map((server) => server.serverId);
        return desired.map((server) => {
          const previous = current.find((item) => item.serverId === server.serverId);
          const saved = { ...server };
          delete saved.authState;
          delete saved.configurationBindingId;
          if (resolveMcpServerConnectionMode(saved) === "static") {
            saved.configurationBindingId =
              previous && sameConfiguration(previous, server)
                ? (previous.configurationBindingId ?? randomUUID())
                : randomUUID();
          }
          // Configuration writers cannot roll back a concurrent connection-status update.
          if (previous) {
            saved.status = previous.status;
            saved.lastConnectedAt = previous.lastConnectedAt;
            saved.lastError = previous.lastError;
            if (previous.configurationBindingId !== saved.configurationBindingId) invalidated.push(previous.serverId);
          }
          return saved;
        });
      });
      if (removed.length) await this.removeServerState(removed);
      if (invalidated.length) await this.removeFirstApprovals(invalidated);
    });
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
          ? { ...item, configurationBindingId: item.configurationBindingId ?? randomUUID() }
          : item,
      );
    });
    return servers.find((server) => server.serverId === serverId)!;
  }

  private async mutateServers(update: (current: McpServerRecord[]) => McpServerRecord[]): Promise<McpServerRecord[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await this.ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
      const current = callerOwnedServers(before?.value);
      assertUniqueServers(current);
      const next = update(current);
      if (isDeepStrictEqual(jsonMaterial(next), jsonMaterial(before?.value))) return next;
      const saved = await this.ctx.systemSettings.compareAndSet(MCP_SERVERS_SETTING_KEY, before, next);
      if (saved) return saved.value;
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP registry changed concurrently; reload before retrying.",
    });
  }

  async requireServer(serverId: string): Promise<McpServerRecord> {
    const server = (await this.readServers()).find((item) => item.serverId === serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  async patchServerState(
    serverId: string,
    patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>,
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
    });
    if (GATEWAY_OWNED_MCP_SERVER_IDS.has(serverId)) return applyPatch(await this.requireServer(serverId));
    let updated: McpServerRecord | undefined;
    await this.mutateServers((current) => {
      const target = current.find((item) => item.serverId === serverId);
      if (!target) throw new Error(`Unknown MCP server: ${serverId}`);
      updated = applyPatch(target);
      return current.map((item) => (item.serverId === serverId ? updated! : item));
    });
    if (!updated) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return updated;
  }

  async readTools(): Promise<McpToolRecord[]> {
    const stored = (await this.ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY))?.value;
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted.filter(
      (item): item is McpToolRecord =>
        Boolean(item?.serverId && item?.toolName) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId),
    );
    return [...buildGatewayOwnedInternalMcpTools(), ...callerOwned];
  }

  async writeTools(tools: McpToolRecord[]): Promise<void> {
    await this.ctx.systemSettings.set(
      MCP_TOOLS_SETTING_KEY,
      tools.filter((tool) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(tool.serverId)),
    );
  }

  async readAuthState(): Promise<Record<string, McpAuthStateRecord>> {
    return (await this.ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1"))?.value ?? {};
  }

  async reserveAuthRequest(
    server: McpServerRecord,
    expected: McpAuthStateRecord | undefined,
    kind: McpOAuthTokenRequest["kind"],
  ): Promise<McpOAuthRequestReservation> {
    const input = structuredClone({ server, expected, kind });
    return this.ctx.runImmediateTransaction(async () => {
      const current = await this.requireServer(input.server.serverId);
      assertConfigurationSnapshot([current], [input.server]);
      const configuration = current.configurationBindingId
        ? current
        : await this.ensureStaticConfigurationBinding(current.serverId);
      if (!sameConfiguration(current, configuration)) {
        throw new ConflictError({ message: "MCP configuration changed before OAuth reservation." });
      }
      const prior = input.expected?.tokenRequest;
      if (prior && (prior.kind !== kind || prior.configurationBindingId !== configuration.configurationBindingId)) {
        throw new ConflictError({
          message: "MCP OAuth has an unresolved request; reconnect this server from Settings.",
        });
      }
      const now = new Date().toISOString();
      const auth = {
        ...input.expected,
        updatedAt: input.expected?.updatedAt ?? now,
        tokenRequest: prior ?? {
          requestId: randomUUID(),
          kind,
          configurationBindingId: configuration.configurationBindingId!,
          reservedAt: now,
        },
      };
      await this.writeAuthState({ server: configuration, expected: input.expected, next: auth });
      return { server: configuration, auth };
    });
  }

  async writeAuthState(input: McpAuthStateUpdate): Promise<void> {
    const update = structuredClone(input);
    if (!update?.server?.serverId) throw new TypeError("MCP auth publication requires its server configuration.");
    assertAuthStateTarget(update.server.serverId, update.next);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.ctx.runImmediateTransaction(async () => {
          const before = await this.ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
          const servers = callerOwnedServers(before?.value);
          assertUniqueServers(servers);
          const current = servers.find((server) => server.serverId === update.server.serverId);
          if (!current) throw new ConflictError({ message: "MCP server was removed before auth publication." });
          assertConfigurationSnapshot([current], [update.server]);
          if (resolveMcpServerConnectionMode(current) !== "static" || (update.next && current.authType !== "oauth2")) {
            throw new ConflictError({ message: "MCP auth publication requires static OAuth configuration." });
          }
          const authBefore = await this.ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1");
          const authRows = authBefore?.value ?? {};
          if (!isDeepStrictEqual(jsonMaterial(authRows[current.serverId]), jsonMaterial(update.expected))) {
            throw new ConflictError({ message: "MCP auth state changed before publication." });
          }
          const authorityChanged = !isDeepStrictEqual(
            authAuthorityMaterial(update.expected),
            authAuthorityMaterial(update.next),
          );
          const nextServer = authorityChanged ? { ...current, configurationBindingId: randomUUID() } : current;
          const nextServers = servers.map((server) => (server.serverId === current.serverId ? nextServer : server));
          // Even a metadata-only update takes the configuration-row lock before publishing auth.
          if (!(await this.ctx.systemSettings.compareAndSet(MCP_SERVERS_SETTING_KEY, before, nextServers))) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP registry changed during auth publication.",
            });
          }
          const nextAuth = { ...authRows };
          if (update.next) nextAuth[current.serverId] = update.next;
          else delete nextAuth[current.serverId];
          if (!(await this.ctx.systemSettings.compareAndSet("mcp_auth_state_v1", authBefore, nextAuth))) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP auth registry changed during publication.",
            });
          }
          await this.credentialRetirements.assertPublishable(current.serverId, [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          await this.credentialStaging.publish(current.serverId, [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          await this.credentialRetirements.record(current.serverId,
            [update.expected?.accessTokenRef, update.expected?.refreshTokenRef],
            [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          if (authorityChanged) await this.removeFirstApprovals([current.serverId]);
        });
        return;
      } catch (error) {
        if (!(error instanceof ConflictError) || error.code !== "WRITE_CONFLICT") throw error;
      }
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP auth publication conflicted; reload before retrying.",
    });
  }

  async readEnvironmentBinding(serverId: string): Promise<McpEnvironmentBindingRecord | undefined> {
    return (await this.ctx.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY))
      ?.value[serverId];
  }

  async writeEnvironmentBinding(
    server: McpServerRecord,
    expected: McpEnvironmentBindingRecord | undefined,
    next: McpEnvironmentBindingRecord | undefined,
  ): Promise<McpServerRecord> {
    const input = structuredClone({ server, expected, next });
    if (
      input.next &&
      (Object.keys(input.next).length !== 1 || !isMcpEnvironmentRefForServer(input.next.credentialRef, server.serverId))
    ) {
      throw new ConflictError({ message: "MCP environment credential reference belongs to another authority." });
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.ctx.runImmediateTransaction(async () => {
          const before = await this.ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
          const servers = callerOwnedServers(before?.value);
          assertUniqueServers(servers);
          const current = servers.find((item) => item.serverId === input.server.serverId);
          if (!current || resolveMcpServerConnectionMode(current) !== "static")
            throw new ConflictError({ message: "MCP environment requires current static configuration." });
          assertConfigurationSnapshot([current], [input.server]);
          const environmentBefore =
            await this.ctx.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY);
          const bindings = environmentBefore?.value ?? {};
          if (!isDeepStrictEqual(jsonMaterial(bindings[current.serverId]), jsonMaterial(input.expected))) {
            throw new ConflictError({ message: "MCP environment authority changed before publication." });
          }
          const changed = !isDeepStrictEqual(jsonMaterial(input.expected), jsonMaterial(input.next));
          await this.credentialRetirements.assertPublishable(current.serverId, [input.next?.credentialRef]);
          await this.credentialStaging.publish(current.serverId, [input.next?.credentialRef]);
          const updated = {
            ...current,
            configurationBindingId:
              changed || !current.configurationBindingId ? randomUUID() : current.configurationBindingId,
          };
          if (
            !(await this.ctx.systemSettings.compareAndSet(
              MCP_SERVERS_SETTING_KEY,
              before,
              servers.map((item) => (item.serverId === current.serverId ? updated : item)),
            ))
          ) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP configuration changed during environment publication.",
            });
          }
          if (changed) {
            const nextBindings = { ...bindings };
            if (input.next) nextBindings[current.serverId] = input.next;
            else delete nextBindings[current.serverId];
            if (
              !(await this.ctx.systemSettings.compareAndSet(
                MCP_ENVIRONMENT_SETTING_KEY,
                environmentBefore,
                nextBindings,
              ))
            ) {
              throw new ConflictError({
                code: "WRITE_CONFLICT",
                message: "MCP environment changed during publication.",
              });
            }
            await this.credentialRetirements.record(current.serverId, [input.expected?.credentialRef], [input.next?.credentialRef]);
            if (current.authType === "oauth2") await this.removeAuthState([current.serverId]);
          }
          if (updated.configurationBindingId !== current.configurationBindingId)
            await this.removeFirstApprovals([current.serverId]);
          return updated;
        });
      } catch (error) {
        if (!(error instanceof ConflictError) || error.code !== "WRITE_CONFLICT") throw error;
      }
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP environment publication conflicted; reload before retrying.",
    });
  }

  private async removeAuthState(serverIds: string[]): Promise<void> {
    const auth = await this.ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1");
    if (auth) {
      const next = { ...auth.value };
      for (const serverId of serverIds) delete next[serverId];
      if (!(await this.ctx.systemSettings.compareAndSet("mcp_auth_state_v1", auth, next))) {
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP auth registry changed during removal." });
      }
      for (const serverId of serverIds) await this.credentialRetirements.record(serverId,
        [auth.value[serverId]?.accessTokenRef, auth.value[serverId]?.refreshTokenRef], []);
    }
  }

  private async removeServerState(serverIds: string[]): Promise<void> {
    await this.removeAuthState(serverIds);
    const environment =
      await this.ctx.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY);
    if (environment) {
      const next = { ...environment.value };
      for (const serverId of serverIds) delete next[serverId];
      if (!(await this.ctx.systemSettings.compareAndSet(MCP_ENVIRONMENT_SETTING_KEY, environment, next))) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "MCP environment registry changed during removal.",
        });
      }
      for (const serverId of serverIds) await this.credentialRetirements.record(serverId,
        [environment.value[serverId]?.credentialRef], []);
    }
    const tools = await this.ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY);
    if (
      tools &&
      !(await this.ctx.systemSettings.compareAndSet(
        MCP_TOOLS_SETTING_KEY,
        tools,
        tools.value.filter((tool) => !serverIds.includes(tool.serverId)),
      ))
    ) {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP tool registry changed during removal." });
    }
    await this.removeFirstApprovals(serverIds);
  }

  private async removeFirstApprovals(serverIds: string[]): Promise<void> {
    const approved = await this.ctx.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY);
    if (!approved) return;
    const next = { ...approved.value };
    for (const serverId of serverIds) delete next[serverId];
    if (!(await this.ctx.systemSettings.compareAndSet(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY, approved, next))) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "MCP tool approvals changed during auth publication.",
      });
    }
  }

  async readFirstApprovals(): Promise<Record<string, string[]>> {
    return (
      (await this.ctx.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY))?.value ?? {}
    );
  }

  async isToolApproved(serverId: string, toolName: string): Promise<boolean> {
    const approved = await this.readFirstApprovals();
    return approved[serverId]?.includes(toolName) ?? false;
  }
}

function callerOwnedServers(value: unknown): McpServerRecord[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is McpServerRecord => Boolean(item?.serverId))
    .filter((item) => !isGatewayOwnedMcpServerUrl(item.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId))
    .map((item) => ({
      ...item,
      category: item.category ?? inferMcpCategory(item.transport),
      trustTier: item.trustTier ?? "restricted",
      costTier: item.costTier ?? "unknown",
      policy: normalizeMcpPolicy(item.policy),
    }));
}

function jsonMaterial(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

function authAuthorityMaterial(state: McpAuthStateRecord | undefined): unknown {
  if (
    !state ||
    (!state.accessTokenRef &&
      !state.refreshTokenRef &&
      !state.tokenExpiresAt &&
      !state.scopes?.length &&
      !state.resourceIndicator)
  )
    return undefined;
  return jsonMaterial({
    accessTokenRef: state.accessTokenRef,
    refreshTokenRef: state.refreshTokenRef,
    tokenExpiresAt: state.tokenExpiresAt,
    scopes: state.scopes,
    resourceIndicator: state.resourceIndicator,
  });
}

function assertAuthStateTarget(serverId: string, state: McpAuthStateRecord | undefined): void {
  if (!state) return;
  const allowed = new Set([
    "accessTokenRef",
    "refreshTokenRef",
    "tokenExpiresAt",
    "oauthState",
    "scopes",
    "resourceIndicator",
    "updatedAt",
    "lastRefreshedAt",
    "error",
    "lastCodePreview",
    "tokenRequest",
  ]);
  if (Object.keys(state).some((key) => !allowed.has(key))) {
    throw new ConflictError({ message: "MCP auth state contains unsupported fields." });
  }
  if (state.tokenRequest !== undefined) {
    const request = state.tokenRequest;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).length !== 4 ||
      Object.keys(request).some(
        (key) => !["requestId", "kind", "configurationBindingId", "reservedAt"].includes(key),
      ) ||
      typeof request.requestId !== "string" ||
      !uuid.test(request.requestId) ||
      typeof request.configurationBindingId !== "string" ||
      !uuid.test(request.configurationBindingId) ||
      !["authorization_code", "refresh_token"].includes(request.kind) ||
      typeof request.reservedAt !== "string" ||
      !Number.isFinite(Date.parse(request.reservedAt))
    ) {
      throw new ConflictError({ message: "MCP OAuth request reservation is invalid." });
    }
  }
  if (
    (state.accessTokenRef && !isMcpOAuthTokenRefForServer(state.accessTokenRef, serverId, "access-token")) ||
    (state.refreshTokenRef && !isMcpOAuthTokenRefForServer(state.refreshTokenRef, serverId, "refresh-token")) ||
    (state.resourceIndicator !== undefined && state.resourceIndicator !== `mcp://${serverId}`)
  ) {
    throw new ConflictError({ message: "MCP credential references belong to another authority." });
  }
}

function assertUniqueServers(servers: McpServerRecord[]): void {
  if (new Set(servers.map((server) => server.serverId)).size !== servers.length) {
    throw new ConflictError({ message: "MCP registry contains duplicate server identities." });
  }
  for (const server of servers) {
    if (
      server.configurationBindingId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(server.configurationBindingId)
    ) {
      throw new ConflictError({ message: "MCP configuration identity is invalid." });
    }
  }
}

function configurationMaterial(server: McpServerRecord): unknown {
  const material: Partial<McpServerRecord> = {
    ...server,
    category: server.category ?? inferMcpCategory(server.transport),
    trustTier: server.trustTier ?? "restricted",
    costTier: server.costTier ?? "unknown",
    policy: normalizeMcpPolicy(server.policy),
  };
  for (const key of [
    "authState",
    "configurationBindingId",
    "status",
    "lastConnectedAt",
    "lastError",
    "updatedAt",
  ] as const) {
    delete material[key];
  }
  // Inventory normalization adds optional undefined fields; persistence omits them.
  return JSON.parse(JSON.stringify(material)) as unknown;
}

function sameConfiguration(left: McpServerRecord, right: McpServerRecord): boolean {
  return isDeepStrictEqual(configurationMaterial(left), configurationMaterial(right));
}

function assertConfigurationSnapshot(current: McpServerRecord[], expected: McpServerRecord[]): void {
  if (
    current.length !== expected.length ||
    current.some((server) => {
      const previous = expected.find((item) => item.serverId === server.serverId);
      return (
        !previous ||
        previous.configurationBindingId !== server.configurationBindingId ||
        !sameConfiguration(previous, server)
      );
    })
  ) {
    throw new ConflictError({ message: "MCP configuration changed; reload before applying this edit." });
  }
}

function buildGatewayOwnedInternalMcpServers(authRows: Record<string, McpAuthStateRecord>): McpServerRecord[] {
  return [
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-approval-inbox", MCP_APPROVAL_INBOX_URL, authRows),
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-durable-tasks", MCP_DURABLE_TASKS_URL, authRows),
  ].filter((server): server is McpServerRecord => Boolean(server));
}

function buildGatewayOwnedInternalMcpServer(
  serverId: string,
  url: string,
  authRows: Record<string, McpAuthStateRecord>,
): McpServerRecord | undefined {
  const template = MCP_SERVER_TEMPLATES.find((item) => item.url === url);
  if (!template) {
    return undefined;
  }
  const server: McpServerRecord = {
    serverId,
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    enabled: true,
    status: "connected",
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: normalizeMcpPolicy(template.policy),
    verifiedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    lastConnectedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    createdAt: GATEWAY_OWNED_MCP_CREATED_AT,
    updatedAt: GATEWAY_OWNED_MCP_CREATED_AT,
  };
  return {
    ...server,
    authState: buildPublicMcpAuthState(server, authRows[serverId]),
  };
}

function buildGatewayOwnedInternalMcpTools(): McpToolRecord[] {
  return [
    ...createInternalMcpApprovalInboxTools("goatcitadel-internal-approval-inbox"),
    ...createInternalMcpDurableTasksTools("goatcitadel-internal-durable-tasks"),
  ];
}

function isGatewayOwnedMcpServerUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase();
  return normalized === MCP_APPROVAL_INBOX_URL || normalized === MCP_DURABLE_TASKS_URL;
}
