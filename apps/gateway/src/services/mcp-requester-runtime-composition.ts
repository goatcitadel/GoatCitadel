import { randomUUID } from "node:crypto";
import { canonicalJsonString, type McpNormalizedRequesterDiscoveryCatalog } from "@goatcitadel/contracts";
import { resolveMcpServerConnectionMode } from "@goatcitadel/contracts";
import type { McpInvokeRequest, McpServerRecord } from "@goatcitadel/contracts";
import type { ChatTurnCapabilityProfileRecord, McpRequesterResolutionBinding, McpRequesterScopeAuthActorSource } from "@goatcitadel/contracts";
import { discoverRequesterScopedMcpTools, invokeRequesterScopedMcpToolCall } from "./mcp-runtime.js";
import { McpRequesterResolverRegistry, McpRequesterResolutionError, assertMcpRequesterResolutionBindingIntegrity, assertMcpRequesterBindingServerCurrent, snapshotMcpRequesterScopedServerSnapshot, type McpRequesterResolverRegistryInput, type McpRequesterScopedServerSnapshot, type McpRequesterResolutionReasonCode } from "./mcp-requester-resolution.js";
import { MCP_REQUESTER_COMPOSITION_STATIC_GENERATIONS, McpProfileDiscoveryOutcomeRegistry, McpRequesterResolutionService, McpRequesterScopeLastOutcomeRecorder, buildRequesterScopedPreDispatchFailure, buildMcpRequesterScopedTurnContextFromCapabilityProfile, deriveMcpRequesterScopeOutcomeClassFromInvocationResult, discoverRequesterScopedCatalogForProfile, dispatchRequesterScopedToolCall, readMcpRequesterScopedTurnContext, resolveRequesterScopedBindingForProfileFreeze, resolveRequesterScopedCatalogBindingsForProfileFreeze, type McpRequesterScopeLastOutcomeClass, type McpRequesterScopedFreezeCurrentState, type McpRequesterScopedProfileFreezeHookInput, type McpRequesterScopedCatalogDiscoveryHookInput, type McpRequesterScopedCatalogFreezeHookInput, type McpRequesterScopedToolCallCurrentState } from "./mcp-requester-resolution-service.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import type { McpRequesterScopeDiagnosticsReadPort, McpRequesterScopeResolverRegistrationRef } from "./mcp-diagnostics-service.js";
import { type RequesterScopedMcpDispatchInput, type RequesterScopedMcpDispatchPort } from "./tool-invocation-coordinator-service.js";

/**
 * HX-415 slice 7d composition host. Every port reads LIVE server-owned state on
 * each call (drift/revocation detection); none of them ever receives
 * `McpInvokeRequest`/body-derived authority.
 */
export interface McpRequesterScopedCompositionHost {
  /**
   * Fixed Gateway-owned resolver registry input. Default EMPTY: a stock
   * deployment has no resolvers, so every requester-scoped server fails closed
   * (`resolver_missing` at freeze, `requester_context_missing` at invoke).
   * The packet authorizes no built-in resolver family in v1 and forbids
   * per-requester credential storage without a new security review; tests and
   * the proof lane inject resolvers through the Gateway-owned constructor
   * boundary, which plugins/skills/bodies/Mission Control cannot reach.
   */
  resolvers?: McpRequesterResolverRegistryInput;
  /** Live MCP server records (config owner); re-read on every state check. */
  listMcpServers(): Promise<McpServerRecord[]>;
  /** Metadata discovery is restricted to the canonical workspace/Citadel scope. */
  assertMcpServerInScope?(request: McpInvokeRequest): Promise<void>;
  /** Durable frozen capability-profile record (server-owned storage read); undefined when missing. */
  getChatTurnCapabilityProfile(profileId: string): Promise<ChatTurnCapabilityProfileRecord | undefined>;
  /** Live auth-owner read for the authenticated actor (device/companion grant revocation). */
  readAuthConnectionState(actor: {
    actorId: string;
    actorSource: McpRequesterScopeAuthActorSource;
  }): Promise<{ revoked: boolean }>;
  getNetworkAllowlist(): readonly string[];
  /** Content-free diagnostics; receives ONLY fixed taxonomy reason codes, never endpoint/header/cause text. */
  recordDevDiagnostic(input: {
    level: "warn";
    category: "mcp";
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  now?(): number;
}

export interface McpRequesterScopedComposedRuntime {
  revalidateRequesterTool(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void>;
  discoverMcpRequesterCatalogs(
    input: McpRequesterScopedCatalogDiscoveryHookInput,
  ): Promise<McpNormalizedRequesterDiscoveryCatalog[]>;
  resolveMcpRequesterCatalogBindings(
    input: McpRequesterScopedCatalogFreezeHookInput,
    options: { signal: AbortSignal },
  ): Promise<McpRequesterResolutionBinding[] | undefined>;
  /** Profile-freeze hook body for `ChatTurnCapabilityProfileResolveDeps.resolveMcpRequesterResolutionBinding`. */
  resolveMcpRequesterResolutionBinding(
    input: McpRequesterScopedProfileFreezeHookInput,
  ): Promise<McpRequesterResolutionBinding | undefined>;
  /** App-private coordinator port for `ToolInvocationCoordinatorHost.requesterScopedMcpDispatch`. */
  requesterScopedMcpDispatch: RequesterScopedMcpDispatchPort;
  /**
   * Secret-free operator-diagnostics read port (HX-415 operator-diagnostics
   * tranche): exact-resolver registration posture plus the process-local
   * last-outcome recorder. Read-only; restart drops every recorded outcome.
   */
  requesterScopeDiagnostics: McpRequesterScopeDiagnosticsReadPort;
}

function isMcpRequesterScopeActorSourceValue(value: unknown): value is McpRequesterScopeAuthActorSource {
  return value === "token" || value === "basic" || value === "loopback" || value === "device" || value === "companion";
}

/**
 * Read the LIVE requester-scoped snapshot for one server id. Returns
 * `undefined` — which every 7c reader treats as fail-closed
 * (`server_not_callable`) or "static behavior wins" at the freeze entry — when
 * the server is missing, disabled, quarantined, not `requester_scoped`, or has
 * incomplete resolver configuration. A server flipped to static/disabled
 * mid-flight therefore reads as drift on the next `assertCurrent`.
 */
async function readLiveRequesterScopedServerSnapshot(
  host: Pick<McpRequesterScopedCompositionHost, "listMcpServers">,
  serverId: string,
): Promise<McpRequesterScopedServerSnapshot | undefined> {
  let record: McpServerRecord | undefined;
  try {
    record = (await host.listMcpServers()).find((candidate) => candidate.serverId === serverId);
  } catch {
    return undefined;
  }
  if (!record || !record.enabled || record.trustTier === "quarantined") {
    return undefined;
  }
  try {
    if (resolveMcpServerConnectionMode(record) !== "requester_scoped") {
      return undefined;
    }
    if (
      (record.transport !== "http" && record.transport !== "sse") ||
      typeof record.configurationRevision !== "number" ||
      !record.requesterResolution
    ) {
      return undefined;
    }
    return snapshotMcpRequesterScopedServerSnapshot({
      serverId: record.serverId,
      transport: record.transport,
      connectionMode: "requester_scoped",
      configurationRevision: record.configurationRevision,
      requesterResolution: {
        resolverId: record.requesterResolution.resolverId,
        resolverVersion: record.requesterResolution.resolverVersion,
        configGeneration: record.requesterResolution.configGeneration,
        transportPolicy: {
          allowedSchemes: [...record.requesterResolution.transportPolicy.allowedSchemes],
          allowedHosts: [...record.requesterResolution.transportPolicy.allowedHosts],
          allowedPorts: [...record.requesterResolution.transportPolicy.allowedPorts],
          allowedHeaderNames: [...record.requesterResolution.transportPolicy.allowedHeaderNames],
        },
      },
    });
  } catch {
    return undefined;
  }
}

type RequesterScopedServerMatch = { kind: "none" } | { kind: "ambiguous" } | { kind: "match"; serverId: string };

/**
 * Derive the owning requester-scoped server for one canonical
 * `mcp.<serverId>.<toolName>` name by matching against ACTUAL live server ids
 * (never by string parsing alone, which would be ambiguous for ids containing
 * dots). No requester-scoped match ⇒ static behavior wins silently — static
 * MCP canonical names flow through the same hook. More than one match is
 * unresolvable and fails closed.
 */
async function matchRequesterScopedServerByCanonicalToolName(
  host: Pick<McpRequesterScopedCompositionHost, "listMcpServers">,
  canonicalToolName: string,
): Promise<RequesterScopedServerMatch> {
  if (!canonicalToolName.startsWith("mcp.")) {
    return { kind: "none" };
  }
  let matches: McpServerRecord[];
  try {
    matches = (await host.listMcpServers()).filter((record) => {
      try {
        const prefix = `mcp.${record.serverId}.`;
        return (
          resolveMcpServerConnectionMode(record) === "requester_scoped" &&
          canonicalToolName.startsWith(prefix) &&
          canonicalToolName.length > prefix.length
        );
      } catch {
        return false;
      }
    });
  } catch {
    return { kind: "none" };
  }
  if (matches.length === 0) {
    return { kind: "none" };
  }
  const first = matches[0];
  if (matches.length > 1 || !first) {
    return { kind: "ambiguous" };
  }
  return { kind: "match", serverId: first.serverId };
}

/**
 * HX-415 slice 7d composition root: build the ONE process-wide requester-scoped
 * MCP runtime — fixed resolver registry (default EMPTY), resolution service,
 * discovery secret scanner, process-local discovery-outcome registry — and wire
 * the 7c freeze/invoke orchestrators with the runtime transport drivers
 * injected as port values. `GatewayService` instantiates this exactly once and
 * supplies the returned hook to the capability-profile deps and the returned
 * dispatch port to the tool-invocation coordinator host. Exported so the
 * composed E2E suite can drive the REAL composition against narrow fake hosts.
 */
export function composeMcpRequesterScopedRuntime(
  host: McpRequesterScopedCompositionHost,
): McpRequesterScopedComposedRuntime {
  const resolverInput = host.resolvers ?? { profileDiscovery: [], toolCall: [] };
  const registry = new McpRequesterResolverRegistry(resolverInput);
  const service = new McpRequesterResolutionService(registry, host.now ? { now: host.now } : undefined);
  const scanner = createMcpRequesterDiscoverySecretScanner();
  const outcomes = new McpProfileDiscoveryOutcomeRegistry();
  // HX-415 operator diagnostics: non-secret resolver identity keys derived
  // from the SAME input the fixed registry validated (construction above threw
  // on any malformed entry), plus the bounded process-local last-outcome
  // recorder. Both feed the read-only diagnostics port; neither can resolve.
  // NUL-separated registration key: the registry has already asserted canonical
  // resolver identifiers and semver versions (no whitespace or control
  // characters), so the separator keeps the boundary unambiguous — the same
  // convention as the discovery-outcome registry map key.
  const resolverRegistrationKey = (ref: McpRequesterScopeResolverRegistrationRef): string => {
    const separator = String.fromCharCode(0);
    return `${ref.resolverId}${separator}${ref.resolverVersion}${separator}${ref.configGeneration}`;
  };
  const registeredResolverIds = (resolvers: ReadonlyArray<{ resolverId: string }>): ReadonlySet<string> =>
    new Set(resolvers.map((resolver) => resolver.resolverId));
  const registeredResolverKeys = (
    resolvers: ReadonlyArray<{ resolverId: string; resolverVersion: string; configGeneration: number }>,
  ): ReadonlySet<string> => new Set(resolvers.map((resolver) => resolverRegistrationKey(resolver)));
  const profileDiscoveryResolverIds = registeredResolverIds(resolverInput.profileDiscovery);
  const toolCallResolverIds = registeredResolverIds(resolverInput.toolCall);
  const profileDiscoveryResolverKeys = registeredResolverKeys(resolverInput.profileDiscovery);
  const toolCallResolverKeys = registeredResolverKeys(resolverInput.toolCall);
  const lastOutcomes = new McpRequesterScopeLastOutcomeRecorder();
  const recordLastOutcome = (serverId: string, outcomeClass: McpRequesterScopeLastOutcomeClass): void => {
    try {
      lastOutcomes.recordLastOutcome({ serverId, outcomeClass, atMs: host.now ? host.now() : Date.now() });
    } catch {
      // The recorder is best-effort operator diagnostics and never masks the
      // fail-closed resolution result.
    }
  };
  const requesterScopeDiagnostics: McpRequesterScopeDiagnosticsReadPort = {
    resolveRegistrationPosture: (ref: McpRequesterScopeResolverRegistrationRef) => {
      if (!profileDiscoveryResolverIds.has(ref.resolverId) || !toolCallResolverIds.has(ref.resolverId)) {
        return "resolver_missing";
      }
      const key = resolverRegistrationKey(ref);
      return profileDiscoveryResolverKeys.has(key) && toolCallResolverKeys.has(key)
        ? "registered"
        : "resolver_binding_drift";
    },
    loadLastOutcome: (serverId: string) => lastOutcomes.loadLastOutcome(serverId),
  };
  const reportDiagnostic = (event: string, reasonCode: string): void => {
    try {
      host.recordDevDiagnostic({
        level: "warn",
        category: "mcp",
        event,
        message: "Requester-scoped MCP resolution failed closed.",
        context: { reasonCode },
      });
    } catch {
      // Diagnostics are best-effort and never mask the fail-closed result.
    }
  };

  const readProfileDiscoveryState = async (
    hook: McpRequesterScopedCatalogDiscoveryHookInput,
    serverId: string,
  ): Promise<McpRequesterScopedFreezeCurrentState | undefined> => {
    const server = await readLiveRequesterScopedServerSnapshot(host, serverId);
    if (!server) {
      return undefined;
    }
    // The freeze orchestrator's identity gate runs before any state read, so
    // these narrows only defend against malformed hook input.
    if (!hook.authActorId || !isMcpRequesterScopeActorSourceValue(hook.authActorSource)) {
      return undefined;
    }
    await host.assertMcpServerInScope?.({
      serverId,
      toolName: "__profile_discovery__",
      agentId: "assistant",
      workspaceId: hook.workspaceId,
      sessionId: hook.sessionId,
    });
    const auth = await host.readAuthConnectionState({
      actorId: hook.authActorId,
      actorSource: hook.authActorSource,
    });
    return {
      revoked: auth.revoked,
      actorId: hook.authActorId,
      actorSource: hook.authActorSource,
      workspaceId: hook.workspaceId,
      sessionId: hook.sessionId,
      turnId: hook.turnId,
      futureProfileId: hook.profileId,
      // Enumeration uses the base catalog. Binding freeze runs a fresh
      // discovery against the final catalog and retains only that outcome.
      baseCallableCatalogSha256: hook.callableCatalogSha256,
      server,
      ...MCP_REQUESTER_COMPOSITION_STATIC_GENERATIONS,
      connectionGenerationCurrent: true,
      rotationGenerationCurrent: true,
    };
  };

  const discoverMcpRequesterCatalogs = async (
    hook: McpRequesterScopedCatalogDiscoveryHookInput,
  ): Promise<McpNormalizedRequesterDiscoveryCatalog[]> => {
    if (!host.assertMcpServerInScope || !hook.authActorId || !isMcpRequesterScopeActorSourceValue(hook.authActorSource))
      return [];
    const ids: string[] = [];
    for (const server of await host.listMcpServers()) {
      try {
        if (
          resolveMcpServerConnectionMode(server) !== "requester_scoped" ||
          !server.enabled ||
          server.trustTier === "quarantined" ||
          !server.requesterResolution
        )
          continue;
        const posture = requesterScopeDiagnostics.resolveRegistrationPosture(server.requesterResolution);
        if (posture !== "registered") {
          recordLastOutcome(server.serverId, posture);
          continue;
        }
        ids.push(server.serverId);
      } catch {
        reportDiagnostic("mcp.requester_resolution.catalog_failed", "server_not_callable");
      }
    }
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length > 16)
      reportDiagnostic("mcp.requester_resolution.catalog_limited", "native_catalog_server_limit");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    deadline.unref();
    const catalogs: McpNormalizedRequesterDiscoveryCatalog[] = [];
    try {
      // Bound both total work and concurrent connections. Every attempt keeps
      // its own resolver deadline and is disposed by the discovery owner.
      const selectedIds = uniqueIds.slice(0, 16);
      for (let offset = 0; offset < selectedIds.length && !controller.signal.aborted; offset += 4) {
        const batch = await Promise.all(
          selectedIds.slice(offset, offset + 4).map(async (serverId) => {
            const catalog = await discoverRequesterScopedCatalogForProfile({
              hook,
              service,
              scanner,
              networkAllowlist: [...host.getNetworkAllowlist()],
              readCurrentState: () => readProfileDiscoveryState(hook, serverId),
              discoverTools: discoverRequesterScopedMcpTools,
              createAttemptId: () => randomUUID(),
              signal: controller.signal,
              onDiagnostic: (reasonCode) => {
                reportDiagnostic("mcp.requester_resolution.catalog_failed", reasonCode);
                recordLastOutcome(serverId, reasonCode);
              },
              ...(host.now ? { now: host.now } : {}),
            });
            if (catalog) recordLastOutcome(serverId, "resolved_ok");
            return catalog;
          }),
        );
        for (const catalog of batch) if (catalog) catalogs.push(catalog);
      }
    } finally {
      clearTimeout(deadline);
    }
    return catalogs;
  };

  const resolveMcpRequesterCatalogBindings = async (
    hook: McpRequesterScopedCatalogFreezeHookInput,
    options: { signal: AbortSignal },
  ): Promise<McpRequesterResolutionBinding[] | undefined> => {
    if (!host.assertMcpServerInScope) return undefined;
    const bindings = await resolveRequesterScopedCatalogBindingsForProfileFreeze({
      hook,
      service,
      outcomes,
      scanner,
      signal: options.signal,
      networkAllowlist: [...host.getNetworkAllowlist()],
      readCurrentState: () => readProfileDiscoveryState(hook, hook.serverId),
      discoverTools: discoverRequesterScopedMcpTools,
      createAttemptId: () => randomUUID(),
      onDiagnostic: (reasonCode) => {
        reportDiagnostic("mcp.requester_resolution.freeze_failed", reasonCode);
        recordLastOutcome(hook.serverId, reasonCode);
      },
      ...(host.now ? { now: host.now } : {}),
    });
    if (bindings) recordLastOutcome(hook.serverId, "resolved_ok");
    return bindings;
  };

  const resolveMcpRequesterResolutionBinding = async (
    hook: McpRequesterScopedProfileFreezeHookInput,
  ): Promise<McpRequesterResolutionBinding | undefined> => {
    const match = await matchRequesterScopedServerByCanonicalToolName(host, hook.canonicalToolName);
    if (match.kind === "none") return undefined;
    if (match.kind === "ambiguous") {
      reportDiagnostic("mcp.requester_resolution.freeze_failed", "requester_context_ambiguous");
      return undefined;
    }
    const serverId = match.serverId;
    const binding = await resolveRequesterScopedBindingForProfileFreeze({
      hook,
      service,
      outcomes,
      scanner,
      networkAllowlist: [...host.getNetworkAllowlist()],
      readCurrentState: () => readProfileDiscoveryState(hook, serverId),
      discoverTools: discoverRequesterScopedMcpTools,
      createAttemptId: () => randomUUID(),
      onDiagnostic: (reasonCode) => {
        reportDiagnostic("mcp.requester_resolution.freeze_failed", reasonCode);
        // Operator diagnostics: the taxonomy code is the ONLY failure content
        // that leaves the orchestrator; record it per exact server.
        recordLastOutcome(serverId, reasonCode);
      },
      ...(host.now ? { now: host.now } : {}),
    });
    if (binding) recordLastOutcome(serverId, "resolved_ok");
    return binding;
  };

  const revalidateRequesterTool = async (
    profile: ChatTurnCapabilityProfileRecord,
    canonicalName: string,
  ): Promise<void> => {
    const fail: () => never = () => {
      throw new Error("Requester-scoped MCP capability is no longer current");
    };
    if (!host.assertMcpServerInScope) fail();
    const stored = await host.getChatTurnCapabilityProfile(profile.profileId);
    if (
      !stored ||
      stored.hashes.profileHash !== profile.hashes.profileHash ||
      canonicalJsonString(stored.identity) !== canonicalJsonString(profile.identity)
    )
      fail();
    const selected = stored.selection.tools.filter((tool) => tool.canonicalName === canonicalName);
    const binding = selected.length === 1 ? selected[0]?.mcpRequesterResolution : undefined;
    if (!binding) fail();
    assertMcpRequesterResolutionBindingIntegrity(binding);
    if (
      binding.toolName !== canonicalName ||
      binding.callableCatalogSnapshotId !== profile.catalog.snapshotId ||
      binding.callableCatalogSha256 !== profile.catalog.callableHash
    )
      fail();
    const current = await readProfileDiscoveryState(
      {
        profileId: stored.profileId,
        turnId: stored.identity.turnId,
        sessionId: stored.identity.sessionId,
        workspaceId: stored.identity.workspaceId,
        authActorId: stored.identity.authActorId,
        authActorSource: stored.identity.authActorSource,
        requesterScopeSha256: binding.requesterScopeSha256,
        catalogSnapshotId: stored.catalog.snapshotId,
        callableCatalogSha256: stored.catalog.callableHash,
      },
      binding.serverId,
    );
    if (
      !current ||
      current.revoked ||
      requesterScopeDiagnostics.resolveRegistrationPosture(current.server.requesterResolution) !== "registered"
    )
      fail();
    assertMcpRequesterBindingServerCurrent(binding, current.server);
  };

  const recoveringOutcomes = new Map<string, Promise<McpRequesterResolutionReasonCode | undefined>>();
  const recoverDiscoveryOutcome = async (
    input: RequesterScopedMcpDispatchInput,
    context: NonNullable<ReturnType<typeof readMcpRequesterScopedTurnContext>>,
    canonicalName: string,
  ): Promise<McpRequesterResolutionReasonCode | undefined> => {
    const key = `${context.profileId}\u0000${context.finalProfileSha256}\u0000${canonicalName}`;
    const pending = recoveringOutcomes.get(key);
    if (pending) return pending;
    const recovery = (async (): Promise<McpRequesterResolutionReasonCode | undefined> => {
      try {
        const profile = await host.getChatTurnCapabilityProfile(context.profileId);
        const rebuilt =
          profile &&
          readMcpRequesterScopedTurnContext(buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile));
        if (!profile || !rebuilt || canonicalJsonString(rebuilt) !== canonicalJsonString(context))
          return "requester_context_missing";
        const selected = profile.selection?.tools?.find((tool) => tool.canonicalName === canonicalName);
        const binding = selected?.mcpRequesterResolution;
        if (!binding || !selected?.modelName || binding.serverId !== input.server.serverId)
          return "requester_context_missing";
        await revalidateRequesterTool(profile, canonicalName);
        const hook: McpRequesterScopedProfileFreezeHookInput = {
          profileId: profile.profileId,
          turnId: profile.identity.turnId,
          sessionId: profile.identity.sessionId,
          workspaceId: profile.identity.workspaceId,
          authActorId: profile.identity.authActorId,
          authActorSource: profile.identity.authActorSource,
          catalogSnapshotId: profile.catalog.snapshotId,
          callableCatalogSha256: profile.catalog.callableHash,
          requesterScopeSha256: binding.requesterScopeSha256,
          canonicalToolName: canonicalName,
          modelToolName: selected.modelName,
          expectedBindingSha256: binding.bindingSha256,
          expectedProviderAlias: selected.modelName,
        };
        let failure: McpRequesterResolutionReasonCode = "requester_context_missing";
        const restored = await resolveRequesterScopedBindingForProfileFreeze({
          hook,
          service,
          outcomes,
          scanner,
          signal: input.signal,
          networkAllowlist: [...host.getNetworkAllowlist()],
          readCurrentState: async () => {
            const stored = await host.getChatTurnCapabilityProfile(context.profileId);
            if (!stored || stored.hashes.profileHash !== context.finalProfileSha256) return undefined;
            const state = await readProfileDiscoveryState(hook, binding.serverId);
            if (state) assertMcpRequesterBindingServerCurrent(binding, state.server);
            return state;
          },
          discoverTools: discoverRequesterScopedMcpTools,
          createAttemptId: () => randomUUID(),
          onDiagnostic: (reasonCode) => {
            failure = reasonCode;
            reportDiagnostic("mcp.requester_resolution.recovery_failed", reasonCode);
            recordLastOutcome(binding.serverId, reasonCode);
          },
          ...(host.now ? { now: host.now } : {}),
        });
        return restored ? undefined : failure;
      } catch (error) {
        // No transport detail or credential-bearing cause escapes recovery.
        const reasonCode = error instanceof McpRequesterResolutionError ? error.code : "capability_profile_invalid";
        reportDiagnostic("mcp.requester_resolution.recovery_failed", reasonCode);
        return reasonCode;
      }
    })();
    recoveringOutcomes.set(key, recovery);
    try {
      return await recovery;
    } finally {
      recoveringOutcomes.delete(key);
    }
  };

  const requesterScopedMcpDispatch: RequesterScopedMcpDispatchPort = {
    invoke: async (input: RequesterScopedMcpDispatchInput, options: { effectDispatch: () => Promise<void> }) => {
      // Brand-assert the server-built turn context. A missing value (callers
      // without a canonical Chat profile) or a forged plain
      // object copied from any request DTO fails closed BEFORE any registry,
      // profile, or resolver read — and before the effect fence can be touched.
      const context = readMcpRequesterScopedTurnContext(input.mcpRequesterTurnContext);
      if (!context) {
        reportDiagnostic("mcp.requester_resolution.dispatch_failed", "requester_context_missing");
        recordLastOutcome(input.server.serverId, "requester_context_missing");
        return buildRequesterScopedPreDispatchFailure(input.toolName, "requester_context_missing");
      }
      const serverId = input.server.serverId;
      const canonicalToolName = `mcp.${serverId}.${input.toolName}`;
      if (!outcomes.loadProfileDiscoveryOutcome({ profileId: context.profileId, serverId, canonicalToolName })) {
        const recoveryFailure = await recoverDiscoveryOutcome(input, context, canonicalToolName);
        if (recoveryFailure) {
          recordLastOutcome(serverId, recoveryFailure);
          return buildRequesterScopedPreDispatchFailure(input.toolName, recoveryFailure);
        }
      }
      const readCurrentState = async (): Promise<McpRequesterScopedToolCallCurrentState | undefined> => {
        const server = await readLiveRequesterScopedServerSnapshot(host, serverId);
        if (!server) {
          return undefined;
        }
        // The DURABLE frozen profile record is the live owner for turn
        // identity and profile hashes: re-read it from server-owned storage on
        // every check so a deleted or replaced profile reads as drift.
        const profile = await host.getChatTurnCapabilityProfile(context.profileId);
        if (!profile) {
          return undefined;
        }
        const identity = profile.identity;
        if (!identity.authActorId || !isMcpRequesterScopeActorSourceValue(identity.authActorSource)) {
          return undefined;
        }
        const auth = await host.readAuthConnectionState({
          actorId: identity.authActorId,
          actorSource: identity.authActorSource,
        });
        return {
          revoked: auth.revoked,
          actorId: identity.authActorId,
          actorSource: identity.authActorSource,
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          finalProfileId: profile.profileId,
          finalProfileSha256: profile.hashes.profileHash,
          baseCallableCatalogSha256: profile.catalog.callableHash,
          finalCallableCatalogSha256: profile.catalog.callableHash,
          server,
          ...MCP_REQUESTER_COMPOSITION_STATIC_GENERATIONS,
          connectionGenerationCurrent: true,
          rotationGenerationCurrent: true,
        };
      };
      const result = await dispatchRequesterScopedToolCall({
        context,
        serverId,
        // Canonical name convention pinned by extractMcpRequesterDiscoveryOutputInput.
        canonicalToolName,
        toolName: input.toolName,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        effectDispatch: options.effectDispatch,
        service,
        outcomes,
        scanner,
        networkAllowlist: [...host.getNetworkAllowlist()],
        invokeToolCall: invokeRequesterScopedMcpToolCall,
        readCurrentState,
        createAttemptId: () => randomUUID(),
        ...(host.now ? { now: host.now } : {}),
      });
      // Operator diagnostics: derive the last-outcome class from the result's
      // fixed taxonomy code and ok/failurePhase booleans only — the result is
      // already content-free by the orchestrator/runtime contract.
      recordLastOutcome(serverId, deriveMcpRequesterScopeOutcomeClassFromInvocationResult(result));
      return result;
    },
  };

  return {
    revalidateRequesterTool,
    discoverMcpRequesterCatalogs,
    resolveMcpRequesterCatalogBindings,
    resolveMcpRequesterResolutionBinding,
    requesterScopedMcpDispatch,
    requesterScopeDiagnostics,
  };
}

