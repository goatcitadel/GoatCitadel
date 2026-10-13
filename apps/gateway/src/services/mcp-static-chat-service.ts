import { readHistoricalStaticMcpBinding, assertHistoricalStaticMcpScope, isConnectedStaticServer, scopeFromHook } from "./mcp-static-profile-authority.js";
import { McpStaticChatAdmissionService } from "./mcp-static-chat-admission-service.js";
import {
  canonicalJsonString,
  resolveMcpServerConnectionMode,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
  type McpInvokeRequest,
  type McpRequesterScopeHashInput,
  type McpServerRecord,
  readChatTurnFeatureReferences,
  type ChatTurnFeatureReferences,
  type McpRequesterAdmissionScope,
  type McpStaticAdmissionConnection,
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
} from "./mcp-requester-resolution-service.js";
import {
  readMcpRequesterAdmissionTurnContext,
  type McpChatTurnContextHandle,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";
import {
  assertStaticMcpAdmissionReceipt,
  assertStaticMcpAdmissionServer,
  buildStaticMcpAdmissionReceipt,
  staticAdmissionDigest,
} from "./mcp-static-admission.js";
import {
  bindNativeStaticAdmissionMcpChatToolSchema,
  collectNativeMcpChatCatalogCandidates,
  type NativeMcpChatToolSchema,
} from "./gateway/native-mcp-chat-catalog.js";
import type { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import { hasExplicitMcpIdentifier, selectExplicitStaticMcpServers } from "./mcp-static-selection.js";

export interface StaticMcpChatDispatchInput {
  server: McpServerRecord;
  toolName: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  mcpRequesterTurnContext?: McpChatTurnContextHandle;
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
  admission?: {
    enabled(): Promise<boolean>;
    assertScopeCurrent(scope: McpRequesterAdmissionScope): Promise<void>;
    readAdmission(
      scope: McpRequesterAdmissionScope,
    ): Promise<{ references: ChatTurnFeatureReferences; referenceSha256: string } | undefined>;
    assertToolAllowed(scope: McpRequesterAdmissionScope, canonicalName: string): Promise<void>;
  };
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
  private readonly admissionService: McpStaticChatAdmissionService;
  public constructor(private readonly options: McpStaticChatServiceOptions) {
    this.admissionService = new McpStaticChatAdmissionService(options, {
      connection: (server, refresh) => this.connection(server, refresh),
      normalize: (server, raw, guard) => this.normalize(server, raw, guard),
    });
  }

  public hasAdmissionSelection(content: string): Promise<boolean> {
    return this.admissionService.hasAdmissionSelection(content);
  }

  public discoverAdmission(input: Parameters<McpStaticChatAdmissionService["discoverAdmission"]>[0]) {
    return this.admissionService.discoverAdmission(input);
  }

  public restoreAdmissionSchemas(handle: McpRequesterAdmissionTurnContextHandle): Promise<NativeMcpChatToolSchema[]> {
    return this.admissionService.restoreAdmissionSchemas(handle);
  }

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
      const admission = readMcpRequesterAdmissionTurnContext(input.mcpRequesterTurnContext);
      const context = readMcpRequesterScopedTurnContext(input.mcpRequesterTurnContext);
      if (!context && !admission) throw unavailable();
      const profile = context
        ? await this.options.storage.chatTurnCapabilityProfiles.get(context.profileId)
        : undefined;
      if (profile && !matchesMcpRequesterScopedTurnContextProfile(input.mcpRequesterTurnContext, profile))
        throw unavailable();
      const canonicalName = `mcp.${input.server.serverId}.${input.toolName}`;
      const readCurrent = () =>
        admission
          ? this.admissionService.admittedCall(input.mcpRequesterTurnContext, canonicalName)
          : this.frozen(profile!, canonicalName);
      const frozen = await readCurrent();
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
          await readCurrent();
          await assertMcpStaticEnvironmentCurrent(connection.environment, connection.server);
          signal.throwIfAborted();
          await options.effectDispatch();
          dispatched = true;
          // The durable effect marker awaits storage; recheck authority after
          // that await so a concurrent revoke cannot reach tools/call.
          await readCurrent();
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
            resourceOwner: {
              sessionId: frozen.scope.sessionId,
              turnId: admission?.scope.turnId ?? profile!.identity.turnId,
            },
            scopeKey: canonicalJsonString({
              workspaceId: frozen.scope.workspaceId,
              sessionId: frozen.scope.sessionId,
              turnId: admission?.scope.turnId ?? profile!.identity.turnId,
              actorId: frozen.scope.authActorId,
              actorSource: frozen.scope.authActorSource,
              permission: profile?.governance.permission,
              ...(admission ? { admissionReferenceSha256: admission.referenceSha256 } : {}),
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
    return readHistoricalStaticMcpBinding(this.options, profile, canonicalName);
  }

  private async assertScope(scope: McpRequesterScopeHashInput, serverId: string): Promise<void> {
    return assertHistoricalStaticMcpScope(this.options, scope, serverId);
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
function unavailable(): Error {
  return new Error("Static MCP authority is no longer current.");
}
