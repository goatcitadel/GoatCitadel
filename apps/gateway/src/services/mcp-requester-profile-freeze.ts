import {
  createHash,
} from "node:crypto";
import {
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpRequesterResolutionBinding,
  type McpRequesterScopeAuthActorSource,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolutionError,
  assertMcpRequesterResolutionBindingIntegrity,
  createMcpRequesterProviderAlias,
  matchesMcpRequesterProviderAlias,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  type McpRequesterScopedServerSnapshot,
} from "./mcp-requester-resolution.js";
import type {
  McpRequesterScopedProfileFreezeHookInput,
  McpRequesterScopedCatalogFreezeHookInput,
  McpRequesterScopedFreezeCurrentState,
  McpProfileDiscoveryOutcomeRecord,
} from "./mcp-requester-resolution-service.js";

interface ProfileFreezeDependencies<H> {
  readonly hook: H;
  readonly outcomes: { recordProfileDiscoveryOutcome(outcome: McpProfileDiscoveryOutcomeRecord): void };
  readonly now?: () => number;
}
interface ProfileDiscovery {
  catalog: McpNormalizedRequesterDiscoveryCatalog;
  initial: McpRequesterScopedFreezeCurrentState;
  server: McpRequesterScopedServerSnapshot;
  discoveryAttemptId: string;
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
}

// Called synchronously inside the discovery owner's disposable attempt.
// Validate the full selected batch before recording any frozen outcome.
export function freezeRequesterScopedProfileTool(
  input: ProfileFreezeDependencies<McpRequesterScopedProfileFreezeHookInput>,
  discovery: ProfileDiscovery,
) {
  const { binding, outcome } = buildRequesterScopedProfileDiscoveryBinding(
    input.hook,
    discovery,
    (input.now ?? Date.now)(),
  );
  input.outcomes.recordProfileDiscoveryOutcome(outcome);
  return binding;
}

export function freezeRequesterScopedProfileCatalog(
  input: ProfileFreezeDependencies<McpRequesterScopedCatalogFreezeHookInput>,
  discovery: ProfileDiscovery,
) {
  if (
    input.hook.serverId !== discovery.server.serverId ||
    input.hook.tools.length > 256 ||
    new Set(input.hook.tools.map((tool) => tool.canonicalToolName)).size !== input.hook.tools.length
  ) {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
  // Check every descriptor before recording any outcome. A drifting server
  // cannot leave a partially authorized batch behind.
  const selected = input.hook.tools.map((tool) =>
    buildRequesterScopedProfileDiscoveryBinding(
      {
        ...input.hook,
        ...tool,
        modelToolName: "",
      },
      discovery,
      (input.now ?? Date.now)(),
    ),
  );
  for (const { outcome } of selected) input.outcomes.recordProfileDiscoveryOutcome(outcome);
  return selected.map(({ binding }) => binding);
}

function buildRequesterScopedProfileDiscoveryBinding(
  hook: McpRequesterScopedProfileFreezeHookInput,
  {
    catalog,
    initial,
    server,
    discoveryAttemptId,
    actorId,
    actorSource,
  }: {
    catalog: McpNormalizedRequesterDiscoveryCatalog;
    initial: McpRequesterScopedFreezeCurrentState;
    server: McpRequesterScopedServerSnapshot;
    discoveryAttemptId: string;
    actorId: string;
    actorSource: McpRequesterScopeAuthActorSource;
  },
  recordedAtMs: number,
): { binding: McpRequesterResolutionBinding; outcome: McpProfileDiscoveryOutcomeRecord } {
  const tool = catalog.tools.find((candidate) => candidate.canonicalToolName === hook.canonicalToolName);
  if (!tool) throw new McpRequesterResolutionError("server_not_callable");
  if (
    hook.expectedToolDefinitionSha256 !== undefined &&
    hook.expectedToolDefinitionSha256 !== tool.toolDefinitionSha256
  ) {
    throw new McpRequesterResolutionError("schema_revalidation_drift");
  }
  const requesterScopeSha256 = digest(
    mcpRequesterScopeHashMaterial({
      profileId: hook.profileId,
      turnId: hook.turnId,
      sessionId: hook.sessionId,
      workspaceId: hook.workspaceId,
      authActorId: actorId,
      authActorSource: actorSource,
    }),
  );
  if (hook.requesterScopeSha256 !== undefined && hook.requesterScopeSha256 !== requesterScopeSha256) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  const material = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped" as const,
    serverId: server.serverId,
    toolName: hook.canonicalToolName,
    resolverId: server.requesterResolution.resolverId,
    resolverVersion: server.requesterResolution.resolverVersion,
    resolverConfigGeneration: server.requesterResolution.configGeneration,
    requesterScopeSha256,
    serverConfigRevision: server.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(server),
    transportPolicySha256: mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy),
    callableCatalogSnapshotId: hook.catalogSnapshotId,
    callableCatalogSha256: hook.callableCatalogSha256,
    ...(initial.meshActivation === undefined ? {} : { meshActivation: initial.meshActivation }),
  };
  const binding = Object.freeze({ ...material, bindingSha256: digest(material) }) as McpRequesterResolutionBinding;
  assertMcpRequesterResolutionBindingIntegrity(binding);
  const aliasInput = {
    serverId: server.serverId,
    rawRemoteToolName: tool.rawRemoteToolName,
    canonicalToolName: tool.canonicalToolName,
    normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
    bindingSha256: binding.bindingSha256,
  };
  const providerAlias = hook.expectedProviderAlias ?? createMcpRequesterProviderAlias(aliasInput);
  if (
    (hook.expectedBindingSha256 !== undefined && hook.expectedBindingSha256 !== binding.bindingSha256) ||
    !matchesMcpRequesterProviderAlias(aliasInput, providerAlias)
  ) {
    throw new McpRequesterResolutionError("schema_revalidation_drift");
  }
  const outcome: McpProfileDiscoveryOutcomeRecord = {
    profileId: hook.profileId,
    serverId: server.serverId,
    canonicalToolName: hook.canonicalToolName,
    discoveryAttemptId,
    discoveryAttemptGeneration: 1,
    rawRemoteToolName: tool.rawRemoteToolName,
    providerAlias,
    normalizedDiscoveryCatalogSha256: catalog.catalogSha256,
    normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
    bindingSha256: binding.bindingSha256,
    requesterScopeSha256,
    recordedAtMs,
  };
  return { binding, outcome };
}

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}
