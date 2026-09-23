import {
  canonicalJsonString,
  resolveMcpServerConnectionMode,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
  type McpInvokeRequest,
  type McpRequesterScopeHashInput,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import {
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilityProfile,
  type AsyncStorage,
} from "@goatcitadel/storage";
import { createStaticMcpCallAuthority } from "./mcp-static-call-authority.js";
import {
  assertStaticMcpToolBindingIntegrity,
  createStaticMcpCatalogSnapshot,
  staticMcpProviderDefinition,
  type StaticMcpCatalogSnapshot,
} from "./mcp-static-catalog.js";
import {
  assertMcpStaticEnvironmentCurrent,
  readMcpStaticEnvironment,
  type McpStaticEnvironmentHandle,
  type McpStaticEnvironmentService,
} from "./mcp-static-environment-service.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS, type McpServerStore } from "./mcp-server-store.js";
import {
  discoverStaticMcpToolsList,
  invokeMcpRuntimeTool,
  type McpRuntimeInvocationResult,
  type McpRuntimeTransportOptions,
  type StdioClient,
} from "./mcp-runtime.js";
import {
  createMcpRequesterDiscoverySecretScanner,
  createMcpResolutionSecretGuard,
  type McpResolutionSecretGuard,
} from "./mcp-resolution-secret-guard.js";
import {
  extractMcpRequesterDiscoveryOutputInput,
  McpRequesterResolutionError,
  normalizeMcpRequesterDiscoveryOutput,
} from "./mcp-requester-resolution.js";
import {
  matchesMcpRequesterScopedTurnContextProfile,
  readMcpRequesterScopedTurnContext,
  type McpRequesterScopedCatalogDiscoveryHookInput,
  type McpRequesterScopedTurnContextHandle,
} from "./mcp-requester-resolution-service.js";
import type { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";

export interface StaticMcpChatDispatchInput {
  server: McpServerRecord;
  toolName: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle;
}
export interface StaticMcpChatDispatchPort {
  invoke(
    input: StaticMcpChatDispatchInput,
    options: { effectDispatch(): Promise<void> },
  ): Promise<McpRuntimeInvocationResult>;
}
export interface McpStaticChatServiceOptions {
  registry: Pick<McpServerStore, "readServers" | "requireServer">;
  environment: Pick<McpStaticEnvironmentService, "capture">;
  storage: Pick<AsyncStorage, "chatTurnCapabilityProfiles" | "capabilityCatalogSnapshots">;
  assertMcpServerInScope(request: McpInvokeRequest): Promise<void>;
  readAuthConnectionState(actor: {
    actorId: string;
    actorSource: McpRequesterScopeHashInput["authActorSource"];
  }): Promise<{ revoked: boolean }>;
  listCallableCapabilities(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
  resolveOAuthAccessToken(server: McpServerRecord): Promise<string | undefined>;
  getNetworkAllowlist(): string[];
  packageRoot: string;
  stdioPool: McpStdioSessionPool<StdioClient>;
  onDiscoveryUnavailable?(serverId: string, reasonCode: string): void;
}

interface CapturedCatalog {
  server: McpServerRecord;
  environment: McpStaticEnvironmentHandle;
  scope: McpRequesterScopeHashInput;
}

// Matches redactSecretText's literal floor for environment secrets: shorter static values
// (endpoint segments such as "mcp" or "sse", flags such as "1") occur in ordinary tool text.
const STATIC_MCP_MINIMUM_LITERAL_SECRET_LENGTH = 12;

/** Static named tools share Chat scope, policy and durable effects; connection material stays private. */
export class McpStaticChatService implements StaticMcpChatDispatchPort {
  private readonly captured = new WeakMap<StaticMcpCatalogSnapshot, CapturedCatalog>();
  public constructor(private readonly options: McpStaticChatServiceOptions) {}

  public async discover(hook: McpRequesterScopedCatalogDiscoveryHookInput): Promise<StaticMcpCatalogSnapshot[]> {
    const scope = scopeFromHook(hook);
    const servers = (await this.options.registry.readServers())
      .filter(isConnectedStaticServer)
      .sort((a, b) => a.serverId.localeCompare(b.serverId))
      .slice(0, 16);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref();
    const results: StaticMcpCatalogSnapshot[] = [];
    try {
      for (let offset = 0; offset < servers.length && !controller.signal.aborted; offset += 4) {
        const batch = await Promise.all(
          servers.slice(offset, offset + 4).map(async (server) => {
            let guard: McpResolutionSecretGuard | undefined;
            let stage = "authority_unavailable";
            try {
              await this.assertScope(scope, server.serverId);
              const connection = await this.connection(server, true);
              guard = connection.guard;
              stage = "transport_unavailable";
              const raw = await discoverStaticMcpToolsList(
                connection.server,
                10_000,
                {
                  ...connection.transport,
                  actorContext: {
                    authActorId: scope.authActorId,
                    authActorSource: scope.authActorSource,
                    workspaceId: scope.workspaceId,
                    sessionId: scope.sessionId,
                  },
                },
                controller.signal,
              );
              stage = "catalog_rejected";
              const snapshot = this.normalize(connection.server, raw, guard);
              stage = "authority_changed";
              await this.assertScope(scope, server.serverId);
              this.captured.set(snapshot, { server: connection.server, environment: connection.environment, scope });
              return snapshot;
            } catch (error) {
              // No endpoint, command, schema fragment or credential-bearing cause enters diagnostics.
              this.options.onDiscoveryUnavailable?.(
                server.serverId,
                error instanceof McpRequesterResolutionError ? error.code : stage,
              );
              return undefined;
            } finally {
              guard?.dispose();
            }
          }),
        );
        results.push(...batch.filter((value): value is StaticMcpCatalogSnapshot => value !== undefined));
      }
    } finally {
      clearTimeout(timer);
    }
    return results;
  }

  public async assertCatalogCurrent(
    snapshot: StaticMcpCatalogSnapshot,
    hook: McpRequesterScopedCatalogDiscoveryHookInput,
  ): Promise<void> {
    const entry = this.captured.get(snapshot);
    if (!entry || canonicalJsonString(entry.scope) !== canonicalJsonString(scopeFromHook(hook))) throw unavailable();
    await this.assertScope(entry.scope, snapshot.serverId);
    await assertMcpStaticEnvironmentCurrent(entry.environment, entry.server);
  }

  public async revalidateTool(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void> {
    const frozen = await this.frozen(profile, canonicalName);
    await this.options.environment.capture(frozen.server);
  }

  public async invoke(
    input: StaticMcpChatDispatchInput,
    options: { effectDispatch(): Promise<void> },
  ): Promise<McpRuntimeInvocationResult> {
    let guard: McpResolutionSecretGuard | undefined;
    let dispatched = false;
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), 25_000);
    timer.unref();
    try {
      const context = readMcpRequesterScopedTurnContext(input.mcpRequesterTurnContext);
      if (!context) throw unavailable();
      const profile = await this.options.storage.chatTurnCapabilityProfiles.get(context.profileId);
      if (!matchesMcpRequesterScopedTurnContextProfile(input.mcpRequesterTurnContext, profile)) throw unavailable();
      const canonicalName = `mcp.${input.server.serverId}.${input.toolName}`;
      const frozen = await this.frozen(profile, canonicalName);
      if (input.server.configurationBindingId !== frozen.binding.configurationBindingId) throw unavailable();
      const connection = await this.connection(frozen.server, false);
      guard = connection.guard;
      const secretGuard = guard;
      const authority = createStaticMcpCallAuthority({
        revalidateCatalog: async (raw) => {
          const fresh = this.normalize(connection.server, raw, secretGuard);
          const tool = fresh.catalog.tools.find(
            (candidate) => candidate.rawRemoteToolName === frozen.binding.nativeToolName,
          );
          if (
            !tool ||
            canonicalJsonString(staticMcpProviderDefinition(fresh, tool)) !==
              canonicalJsonString(frozen.tool.providerDefinition)
          )
            throw unavailable();
        },
        beforeDispatch: async () => {
          await this.frozen(profile, canonicalName);
          await assertMcpStaticEnvironmentCurrent(connection.environment, connection.server);
          signal.throwIfAborted();
          await options.effectDispatch();
          dispatched = true;
          // The durable effect marker awaits storage; recheck authority after
          // that await so a concurrent revoke cannot reach tools/call.
          await this.frozen(profile, canonicalName);
          await assertMcpStaticEnvironmentCurrent(connection.environment, connection.server);
          signal.throwIfAborted();
        },
      });
      const result = await invokeMcpRuntimeTool(
        connection.server,
        { toolName: frozen.binding.nativeToolName, arguments: input.arguments, signal },
        20_000,
        {
          ...connection.transport,
          staticToolCall: authority,
          actorContext: {
            authActorId: frozen.scope.authActorId,
            authActorSource: frozen.scope.authActorSource,
            workspaceId: frozen.scope.workspaceId,
            sessionId: frozen.scope.sessionId,
          },
          stdioSession: {
            pool: this.options.stdioPool,
            scopeKey: canonicalJsonString({
              workspaceId: frozen.scope.workspaceId,
              sessionId: frozen.scope.sessionId,
              actorId: frozen.scope.authActorId,
              actorSource: frozen.scope.authActorSource,
              permission: profile.governance.permission,
            }),
          },
        },
      );
      const output = result.output === undefined ? undefined : secretGuard.scrubDiagnostic(result.output);
      const items = result.contentItems === undefined ? undefined : secretGuard.scrubDiagnostic(result.contentItems);
      return {
        ...result,
        // Scan payloads independently: output.content and contentItems can share
        // references. Preserve Gateway-owned outcome fields and optional values.
        output:
          output === undefined
            ? undefined
            : output && typeof output === "object" && !Array.isArray(output)
              ? (output as Record<string, unknown>)
              : { redacted: true },
        contentItems:
          items === undefined
            ? undefined
            : Array.isArray(items) &&
                items.every(
                  (item, index) => item && typeof item === "object" && item.type === result.contentItems![index]?.type,
                )
              ? (items as NonNullable<McpRuntimeInvocationResult["contentItems"]>)
              : [{ type: "text", text: "[REDACTED]" }],
        error: result.error === undefined ? undefined : secretGuard.scrubText(result.error),
        ...(!result.ok
          ? {
              failurePhase: dispatched ? ("post_dispatch" as const) : ("pre_dispatch" as const),
              ...(dispatched
                ? { externalOutcome: "unknown_after_send" as const, manualReconciliationRequired: true }
                : {}),
            }
          : {}),
      };
    } catch {
      return {
        ok: false,
        error: dispatched
          ? "Static MCP tool outcome is unknown after dispatch; review its retained execution evidence."
          : "Static MCP tool authority or schema changed; reconnect the server or start a new Chat turn.",
        failurePhase: dispatched ? "post_dispatch" : "pre_dispatch",
        ...(dispatched ? { externalOutcome: "unknown_after_send" as const, manualReconciliationRequired: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      guard?.dispose();
    }
  }

  private async frozen(profile: ChatTurnCapabilityProfileRecord, canonicalName: string) {
    const stored = await this.options.storage.chatTurnCapabilityProfiles.get(profile.profileId);
    verifyChatTurnCapabilityProfile(stored);
    if (
      stored.hashes.profileHash !== profile.hashes.profileHash ||
      canonicalJsonString(stored.identity) !== canonicalJsonString(profile.identity)
    )
      throw unavailable();
    const catalog = await this.options.storage.capabilityCatalogSnapshots.get(stored.catalog.snapshotId);
    verifyChatTurnCapabilityCatalogBinding(stored, catalog);
    const selected = stored.selection.tools.filter((tool) => tool.canonicalName === canonicalName);
    const tool = selected.length === 1 ? selected[0] : undefined;
    const binding = tool?.mcpStaticBinding;
    if (!binding || !tool) throw unavailable();
    assertStaticMcpToolBindingIntegrity(binding);
    const scope = scopeFromProfile(stored);
    await this.assertScope(scope, binding.serverId);
    const live = await this.options.listCallableCapabilities(scope.workspaceId);
    const shared = catalog.callableEntries.find((entry) => entry.kind === "tool" && entry.toolName === "mcp.invoke");
    if (
      !shared ||
      !live.some((entry) => entry.callable && canonicalJsonString(entry) === canonicalJsonString(shared)) ||
      live.some((entry) => entry.toolName === canonicalName || entry.capabilityId === `tool:${canonicalName}`)
    )
      throw unavailable();
    const server = await this.options.registry.requireServer(binding.serverId);
    if (
      !isConnectedStaticServer(server) ||
      server.configurationBindingId !== binding.configurationBindingId ||
      server.transport !== binding.transport
    )
      throw unavailable();
    return { server, binding, tool, scope };
  }

  private async assertScope(scope: McpRequesterScopeHashInput, serverId: string): Promise<void> {
    await this.options.assertMcpServerInScope({
      serverId,
      toolName: "__profile_discovery__",
      agentId: "assistant",
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    });
    if (
      (await this.options.readAuthConnectionState({ actorId: scope.authActorId, actorSource: scope.authActorSource }))
        .revoked
    )
      throw unavailable();
  }

  private async connection(original: McpServerRecord, allowRefreshedConfiguration: boolean) {
    if (!isConnectedStaticServer(original)) throw unavailable();
    const token = original.authType === "oauth2" ? await this.options.resolveOAuthAccessToken(original) : undefined;
    const server = await this.options.registry.requireServer(original.serverId);
    if (
      !isConnectedStaticServer(server) ||
      canonicalJsonString(configurationMaterial(original)) !== canonicalJsonString(configurationMaterial(server)) ||
      (!allowRefreshedConfiguration && server.configurationBindingId !== original.configurationBindingId)
    )
      throw unavailable();
    const environment = await this.options.environment.capture(server);
    const values = readMcpStaticEnvironment(environment, server);
    const keys = normalizeSafeEnvKeyNames([
      ...(server.policy.allowedEnvKeys ?? []),
      ...(server.oauth?.clientIdEnv ? [server.oauth.clientIdEnv] : []),
      ...(server.oauth?.clientSecretEnv ? [server.oauth.clientSecretEnv] : []),
    ]);
    const secrets = keys.flatMap((key) =>
      values[key] ? [{ name: `X-MCP-Environment-${key}`, value: values[key]! }] : [],
    );
    if (token) secrets.push({ name: "Authorization", value: `Bearer ${token}` });
    const guard = createMcpResolutionSecretGuard({
      ...(server.url ? { url: server.url } : {}),
      headers: secrets,
      minimumLiteralLength: STATIC_MCP_MINIMUM_LITERAL_SECRET_LENGTH,
    });
    const transport: McpRuntimeTransportOptions = {
      networkAllowlist: this.options.getNetworkAllowlist(),
      packageRoot: this.options.packageRoot,
      staticEnvironment: environment,
      oauthAccessTokenResolver: async () => token,
    };
    return { server, environment, guard, transport };
  }

  private normalize(server: McpServerRecord, raw: unknown, guard: McpResolutionSecretGuard): StaticMcpCatalogSnapshot {
    const catalog = normalizeMcpRequesterDiscoveryOutput(
      server.serverId,
      extractMcpRequesterDiscoveryOutputInput(server.serverId, raw),
      createMcpRequesterDiscoverySecretScanner(),
    );
    // Scan bounded remote metadata only: generated "mcp." names can match an
    // endpoint path segment even when the server returned no connection material.
    const remoteMaterial = canonicalJsonString(
      catalog.tools.map((tool) => ({
        rawRemoteToolName: tool.rawRemoteToolName,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      })),
    );
    if (guard.scrubText(remoteMaterial) !== remoteMaterial)
      throw new McpRequesterResolutionError("discovery_secret_detected");
    return createStaticMcpCatalogSnapshot(server, catalog);
  }
}

function isConnectedStaticServer(server: McpServerRecord): boolean {
  return (
    !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId) &&
    resolveMcpServerConnectionMode(server) === "static" &&
    server.enabled &&
    server.status === "connected" &&
    Boolean(server.configurationBindingId)
  );
}
function configurationMaterial(server: McpServerRecord): unknown {
  const value = { ...server };
  for (const key of [
    "revision",
    "connectionRevision",
    "configurationBindingId",
    "authState",
    "status",
    "updatedAt",
    "lastConnectedAt",
    "lastError",
  ] as const)
    delete value[key];
  return JSON.parse(JSON.stringify(value)) as unknown;
}
function scopeFromHook(hook: McpRequesterScopedCatalogDiscoveryHookInput): McpRequesterScopeHashInput {
  if (!hook.authActorId || !["token", "basic", "loopback", "device", "companion"].includes(hook.authActorSource ?? ""))
    throw unavailable();
  return {
    profileId: hook.profileId,
    turnId: hook.turnId,
    sessionId: hook.sessionId,
    workspaceId: hook.workspaceId,
    authActorId: hook.authActorId,
    authActorSource: hook.authActorSource as McpRequesterScopeHashInput["authActorSource"],
  };
}
function scopeFromProfile(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopeHashInput {
  return scopeFromHook({
    profileId: profile.profileId,
    ...profile.identity,
    catalogSnapshotId: profile.catalog.snapshotId,
    callableCatalogSha256: profile.catalog.callableHash,
  });
}
function unavailable(): Error {
  return new Error("Static MCP authority is no longer current.");
}
