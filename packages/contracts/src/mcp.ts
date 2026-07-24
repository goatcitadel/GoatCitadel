/* eslint-disable max-lines -- MCP contracts stay in one browser-safe public module. */
import type { ChannelProbeReport } from "./channel-probes.js";
import type { CapabilityCatalogEntry, CapabilityKind } from "./capabilities.js";
import type { PermissionSurface, ToolPolicyActorContext } from "./policy.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";
export type McpServerConnectionMode = "static" | "requester_scoped";
export const MCP_REQUESTER_RESOLUTION_BINDING_VERSION = "goatcitadel.mcp-requester-resolution-binding.v1" as const;
export const MCP_REQUESTER_SCOPE_HASH_MATERIAL_VERSION = "goatcitadel.mcp-requester-scope-hash-material.v1" as const;
export const MCP_PROFILE_DISCOVERY_AUTHORITY_HASH_MATERIAL_VERSION =
  "goatcitadel.mcp-profile-discovery-authority-hash-material.v1" as const;
export const MCP_TOOL_CALL_AUTHORITY_HASH_MATERIAL_VERSION =
  "goatcitadel.mcp-tool-call-authority-hash-material.v1" as const;
export const MCP_REQUESTER_DISCOVERY_TOOL_HASH_MATERIAL_VERSION =
  "goatcitadel.mcp-requester-discovery-tool-hash-material.v1" as const;
export const MCP_REQUESTER_DISCOVERY_CATALOG_HASH_MATERIAL_VERSION =
  "goatcitadel.mcp-requester-discovery-catalog-hash-material.v1" as const;
export const MCP_REQUESTER_PROVIDER_ALIAS_HASH_MATERIAL_VERSION =
  "goatcitadel.mcp-requester-provider-alias-hash-material.v1" as const;
export const MCP_REQUESTER_DISCOVERY_OUTPUT_VERSION = "goatcitadel.mcp-requester-discovery-output.v1" as const;

export const MCP_REQUESTER_DISCOVERY_LIMITS = Object.freeze({
  maxTools: 64,
  maxAggregateBytes: 256 * 1_024,
  maxDescriptionBytes: 8 * 1_024,
  maxSchemaBytesPerTool: 64 * 1_024,
  maxSchemaDepth: 16,
  maxSchemaNodesPerTool: 2_048,
  maxSchemaNodesAggregate: 8_192,
} as const);

export interface McpRequesterResolutionTransportPolicy {
  allowedSchemes: Array<"http" | "https">;
  /** Exact canonical host names only. Wildcards and URL components are forbidden. */
  allowedHosts: string[];
  allowedPorts: number[];
  /** Lowercase RFC 9110 field names. Values are resolved ephemerally and are never stored here. */
  allowedHeaderNames: string[];
}

export interface McpRequesterResolutionConfig {
  resolverId: string;
  resolverVersion: string;
  configGeneration: number;
  transportPolicy: McpRequesterResolutionTransportPolicy;
}

export interface McpRequesterResolutionMeshBinding {
  activationId: string;
  activationRevision: number;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
}

/**
 * Secret-free, immutable evidence that one selected tool may resolve a
 * requester-scoped MCP connection. Resolved destinations and header values are
 * deliberately impossible to represent in this contract.
 */
export interface McpRequesterResolutionBinding {
  schemaVersion: typeof MCP_REQUESTER_RESOLUTION_BINDING_VERSION;
  mode: "requester_scoped";
  serverId: string;
  toolName: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  requesterScopeSha256: string;
  serverConfigRevision: number;
  serverConfigSha256: string;
  transportPolicySha256: string;
  callableCatalogSnapshotId: string;
  callableCatalogSha256: string;
  meshActivation?: McpRequesterResolutionMeshBinding;
  bindingSha256: string;
}

export type McpRequesterResolutionBindingMaterial = Omit<McpRequesterResolutionBinding, "bindingSha256">;

export type McpRequesterScopeAuthActorSource = "token" | "basic" | "loopback" | "device" | "companion";

export interface McpRequesterScopeHashInput {
  profileId: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  authActorId: string;
  authActorSource: McpRequesterScopeAuthActorSource;
}

export interface McpRequesterScopeHashMaterial extends McpRequesterScopeHashInput {
  schemaVersion: typeof MCP_REQUESTER_SCOPE_HASH_MATERIAL_VERSION;
}

export interface McpProfileDiscoveryAuthorityHashInput {
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  futureProfileId: string;
  baseCallableCatalogSha256: string;
  serverId: string;
  serverConfigRevision: number;
  serverConfigSha256: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  transportPolicySha256: string;
  globalNetworkPolicyGeneration: number;
  authConnectionGeneration: number;
  turnGeneration: number;
  preparationGeneration: number;
  meshPublisherGeneration?: number;
  meshActivationGeneration?: number;
  discoveryAttemptId: string;
  discoveryAttemptGeneration: number;
}

export interface McpProfileDiscoveryAuthorityHashMaterial extends McpProfileDiscoveryAuthorityHashInput {
  schemaVersion: typeof MCP_PROFILE_DISCOVERY_AUTHORITY_HASH_MATERIAL_VERSION;
  stage: "profile_discovery";
}

export interface McpToolCallAuthorityHashInput {
  actorId: string;
  actorSource: McpRequesterScopeAuthActorSource;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  finalProfileId: string;
  finalProfileSha256: string;
  baseCallableCatalogSha256: string;
  finalCallableCatalogSha256: string;
  serverId: string;
  serverConfigRevision: number;
  serverConfigSha256: string;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  transportPolicySha256: string;
  globalNetworkPolicyGeneration: number;
  authConnectionGeneration: number;
  turnGeneration: number;
  preparationGeneration: number;
  meshPublisherGeneration?: number;
  meshActivationGeneration?: number;
  profileDiscoveryAttemptId: string;
  profileDiscoveryAttemptGeneration: number;
  revalidationAttemptId: string;
  revalidationAttemptGeneration: number;
  finalEffectAttemptId: string;
  finalEffectAttemptGeneration: number;
  rawRemoteToolName: string;
  canonicalToolName: string;
  providerAlias: string;
  normalizedDiscoveryCatalogSha256: string;
  normalizedToolDefinitionSha256: string;
  bindingSha256: string;
}

export interface McpToolCallAuthorityHashMaterial extends McpToolCallAuthorityHashInput {
  schemaVersion: typeof MCP_TOOL_CALL_AUTHORITY_HASH_MATERIAL_VERSION;
  stage: "tool_call";
}

export interface McpRequesterDiscoveryToolInput {
  rawRemoteToolName: string;
  canonicalToolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequesterDiscoveryOutputInput {
  tools: McpRequesterDiscoveryToolInput[];
}

export interface McpRequesterDiscoverySecretScanEvidence {
  scannerId: string;
  scannerVersion: string;
  scannerGeneration: number;
  scannedSha256: string;
  evidenceSha256: string;
  verdict: "clean";
}

export interface McpRequesterDiscoveryToolHashInput {
  serverId: string;
  rawRemoteToolName: string;
  canonicalToolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequesterDiscoveryToolHashMaterial extends McpRequesterDiscoveryToolHashInput {
  schemaVersion: typeof MCP_REQUESTER_DISCOVERY_TOOL_HASH_MATERIAL_VERSION;
}

export interface McpNormalizedRequesterDiscoveryTool extends McpRequesterDiscoveryToolInput {
  toolDefinitionSha256: string;
}

export interface McpRequesterDiscoveryCatalogHashInput {
  serverId: string;
  secretScan: McpRequesterDiscoverySecretScanEvidence;
  tools: McpNormalizedRequesterDiscoveryTool[];
}

export interface McpRequesterDiscoveryCatalogHashMaterial extends McpRequesterDiscoveryCatalogHashInput {
  schemaVersion: typeof MCP_REQUESTER_DISCOVERY_CATALOG_HASH_MATERIAL_VERSION;
}

export interface McpNormalizedRequesterDiscoveryCatalog extends McpRequesterDiscoveryCatalogHashInput {
  schemaVersion: typeof MCP_REQUESTER_DISCOVERY_OUTPUT_VERSION;
  catalogSha256: string;
}

export interface McpRequesterProviderAliasHashInput {
  serverId: string;
  rawRemoteToolName: string;
  canonicalToolName: string;
  normalizedToolDefinitionSha256: string;
  bindingSha256: string;
}

export interface McpRequesterProviderAliasHashMaterial extends McpRequesterProviderAliasHashInput {
  schemaVersion: typeof MCP_REQUESTER_PROVIDER_ALIAS_HASH_MATERIAL_VERSION;
}
export type McpServerCategory =
  | "development"
  | "browser"
  | "automation"
  | "research"
  | "data"
  | "creative"
  | "orchestration"
  | "other";
export type McpTrustTier = "trusted" | "restricted" | "quarantined";
export type McpCostTier = "free" | "mixed" | "paid" | "unknown";

export interface McpServerPolicy {
  requireFirstToolApproval: boolean;
  redactionMode: "off" | "basic" | "strict";
  allowedToolPatterns: string[];
  blockedToolPatterns: string[];
  /** Explicit env var keys this server needs passed through (e.g. auth tokens, config). */
  allowedEnvKeys?: string[];
  notes?: string;
}

export interface McpOAuthConfig {
  authorizationUrl?: string;
  tokenUrl?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  redirectUri?: string;
  tokenRefreshSkewSeconds?: number;
}

export type McpOAuthReadiness = "not_required" | "needs_auth" | "ready" | "expired" | "missing_oauth_config";

export interface McpServerAuthState {
  authType: McpServerRecord["authType"];
  readiness: McpOAuthReadiness;
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  scopes?: string[];
  updatedAt?: string;
  lastRefreshedAt?: string;
  error?: string;
}

export interface McpServerRecord {
  serverId: string;
  label: string;
  transport: McpTransport;
  /** Missing on legacy rows means `static`. */
  connectionMode?: McpServerConnectionMode;
  /** Server-owned CAS revision. Required for requester-scoped servers. */
  configurationRevision?: number;
  requesterResolution?: McpRequesterResolutionConfig;
  command?: string;
  args?: string[];
  url?: string;
  authType: "none" | "token" | "oauth2";
  oauth?: McpOAuthConfig;
  authState?: McpServerAuthState;
  enabled: boolean;
  status: McpServerStatus;
  category: McpServerCategory;
  trustTier: McpTrustTier;
  costTier: McpCostTier;
  policy: McpServerPolicy;
  verifiedAt?: string;
  lastError?: string;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerTemplateRecord {
  templateId: string;
  label: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  authType: "none" | "token" | "oauth2";
  oauth?: McpOAuthConfig;
  category: McpServerCategory;
  trustTier: McpTrustTier;
  costTier: McpCostTier;
  policy: McpServerPolicy;
  enabledByDefault: boolean;
}

export interface McpToolRecord {
  serverId: string;
  toolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

export interface McpServerCreateInput {
  label: string;
  transport: McpTransport;
  connectionMode?: McpServerConnectionMode;
  requesterResolution?: McpRequesterResolutionConfig;
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  oauth?: McpOAuthConfig;
  enabled?: boolean;
  category?: McpServerCategory;
  trustTier?: McpTrustTier;
  costTier?: McpCostTier;
  policy?: Partial<McpServerPolicy>;
  verifiedAt?: string;
}

export interface McpServerUpdateInput {
  label?: string;
  connectionMode?: McpServerConnectionMode;
  requesterResolution?: McpRequesterResolutionConfig | null;
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  oauth?: McpOAuthConfig;
  enabled?: boolean;
  category?: McpServerCategory;
  trustTier?: McpTrustTier;
  costTier?: McpCostTier;
  policy?: Partial<McpServerPolicy>;
  verifiedAt?: string;
}

export interface McpServerConnectionConfiguration {
  transport: McpTransport;
  connectionMode?: McpServerConnectionMode;
  configurationRevision?: number;
  requesterResolution?: McpRequesterResolutionConfig | null;
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  oauth?: McpOAuthConfig;
  authState?: McpServerAuthState;
  policy?: Partial<McpServerPolicy>;
}

/** Resolve the compatibility default while rejecting an unknown runtime value. */
export function resolveMcpServerConnectionMode(
  input: Pick<McpServerConnectionConfiguration, "connectionMode">,
): McpServerConnectionMode {
  if (input.connectionMode === undefined || input.connectionMode === "static") return "static";
  if (input.connectionMode === "requester_scoped") return "requester_scoped";
  throw new TypeError("MCP server connectionMode is invalid.");
}

/**
 * Enforce the static/requester-scoped split before configuration persistence.
 * This validator intentionally accepts no resolved connection material.
 */
export function assertMcpServerConnectionConfiguration(input: McpServerConnectionConfiguration): void {
  const mode = resolveMcpServerConnectionMode(input);
  if (mode === "static") {
    if (input.requesterResolution !== undefined && input.requesterResolution !== null) {
      throw new TypeError("Static MCP servers cannot carry requester resolution configuration.");
    }
    return;
  }
  assertExactObjectKeys(
    input,
    [
      "args",
      "authState",
      "authType",
      "command",
      "configurationRevision",
      "connectionMode",
      "oauth",
      "policy",
      "requesterResolution",
      "transport",
      "url",
    ],
    "requester-scoped connection configuration",
    ["args", "authState", "authType", "command", "oauth", "policy", "url"],
  );
  if (input.transport !== "http" && input.transport !== "sse") {
    throw new TypeError("Requester-scoped MCP servers require HTTP or SSE transport.");
  }
  if (input.command !== undefined || input.args !== undefined || input.url !== undefined) {
    throw new TypeError("Requester-scoped MCP servers cannot carry a static destination.");
  }
  if (input.authType !== undefined && input.authType !== "none") {
    throw new TypeError("Requester-scoped MCP servers cannot carry static authentication.");
  }
  if (input.oauth !== undefined || input.authState !== undefined) {
    throw new TypeError("Requester-scoped MCP servers cannot carry static authentication state.");
  }
  if (input.policy !== undefined) {
    assertExactObjectKeys(
      input.policy,
      [
        "allowedEnvKeys",
        "allowedToolPatterns",
        "blockedToolPatterns",
        "notes",
        "redactionMode",
        "requireFirstToolApproval",
      ],
      "requester-scoped server policy",
      [
        "allowedEnvKeys",
        "allowedToolPatterns",
        "blockedToolPatterns",
        "notes",
        "redactionMode",
        "requireFirstToolApproval",
      ],
    );
    if (input.policy.allowedEnvKeys !== undefined) {
      if (!Array.isArray(input.policy.allowedEnvKeys) || input.policy.allowedEnvKeys.length > 0) {
        throw new TypeError("Requester-scoped MCP servers cannot pass credential environment variables.");
      }
    }
  }
  assertPositiveSafeInteger(input.configurationRevision, "configurationRevision");
  assertMcpRequesterResolutionConfig(input.requesterResolution);
}

/**
 * Canonical non-secret identity material used to bind a requester-scoped MCP
 * profile entry to the exact authenticated turn. Callers hash the returned
 * material with the repository canonical JSON SHA-256 convention.
 */
export function mcpRequesterScopeHashMaterial(input: McpRequesterScopeHashInput): McpRequesterScopeHashMaterial {
  assertExactObjectKeys(
    input,
    ["authActorId", "authActorSource", "profileId", "sessionId", "turnId", "workspaceId"],
    "requester scope hash input",
  );
  assertCanonicalMcpIdentifier(input.profileId, "requesterScope.profileId", 256);
  assertCanonicalMcpIdentifier(input.turnId, "requesterScope.turnId", 256);
  assertCanonicalMcpIdentifier(input.sessionId, "requesterScope.sessionId", 256);
  assertCanonicalMcpIdentifier(input.workspaceId, "requesterScope.workspaceId", 256);
  assertCanonicalMcpIdentifier(input.authActorId, "requesterScope.authActorId", 256);
  if (
    !(
      "token" === input.authActorSource ||
      "basic" === input.authActorSource ||
      "loopback" === input.authActorSource ||
      "device" === input.authActorSource ||
      "companion" === input.authActorSource
    )
  ) {
    throw new TypeError("MCP requesterScope.authActorSource is not authenticated for requester-scoped MCP.");
  }
  return {
    schemaVersion: MCP_REQUESTER_SCOPE_HASH_MATERIAL_VERSION,
    profileId: input.profileId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
  };
}

/** Domain-separated authority material for the bounded profile-discovery stage. */
export function mcpProfileDiscoveryAuthorityHashMaterial(
  input: McpProfileDiscoveryAuthorityHashInput,
): McpProfileDiscoveryAuthorityHashMaterial {
  assertExactObjectKeys(
    input,
    [
      "actorId",
      "actorSource",
      "authConnectionGeneration",
      "baseCallableCatalogSha256",
      "discoveryAttemptGeneration",
      "discoveryAttemptId",
      "futureProfileId",
      "globalNetworkPolicyGeneration",
      "meshActivationGeneration",
      "meshPublisherGeneration",
      "preparationGeneration",
      "resolverConfigGeneration",
      "resolverId",
      "resolverVersion",
      "serverConfigRevision",
      "serverConfigSha256",
      "serverId",
      "sessionId",
      "transportPolicySha256",
      "turnGeneration",
      "turnId",
      "workspaceId",
    ],
    "profile discovery authority hash input",
    ["meshActivationGeneration", "meshPublisherGeneration"],
  );
  assertMcpRequesterAuthorityScope(input);
  for (const [field, value] of [
    ["futureProfileId", input.futureProfileId],
    ["serverId", input.serverId],
    ["resolverId", input.resolverId],
    ["discoveryAttemptId", input.discoveryAttemptId],
  ] as const) {
    assertCanonicalMcpIdentifier(value, field, 256);
  }
  assertCanonicalSemVer(input.resolverVersion, "resolverVersion");
  assertMcpRequesterAuthorityGenerations(input);
  for (const [field, value] of [
    ["baseCallableCatalogSha256", input.baseCallableCatalogSha256],
    ["serverConfigSha256", input.serverConfigSha256],
    ["transportPolicySha256", input.transportPolicySha256],
  ] as const) {
    assertLowercaseSha256(value, field);
  }
  return {
    schemaVersion: MCP_PROFILE_DISCOVERY_AUTHORITY_HASH_MATERIAL_VERSION,
    stage: "profile_discovery",
    ...input,
  };
}

/** Domain-separated authority material for one exact post-profile tools/call. */
export function mcpToolCallAuthorityHashMaterial(
  input: McpToolCallAuthorityHashInput,
): McpToolCallAuthorityHashMaterial {
  assertExactObjectKeys(
    input,
    [
      "actorId",
      "actorSource",
      "authConnectionGeneration",
      "baseCallableCatalogSha256",
      "bindingSha256",
      "canonicalToolName",
      "finalCallableCatalogSha256",
      "finalEffectAttemptGeneration",
      "finalEffectAttemptId",
      "finalProfileId",
      "finalProfileSha256",
      "globalNetworkPolicyGeneration",
      "meshActivationGeneration",
      "meshPublisherGeneration",
      "normalizedDiscoveryCatalogSha256",
      "normalizedToolDefinitionSha256",
      "preparationGeneration",
      "profileDiscoveryAttemptGeneration",
      "profileDiscoveryAttemptId",
      "providerAlias",
      "rawRemoteToolName",
      "resolverConfigGeneration",
      "resolverId",
      "resolverVersion",
      "revalidationAttemptGeneration",
      "revalidationAttemptId",
      "serverConfigRevision",
      "serverConfigSha256",
      "serverId",
      "sessionId",
      "transportPolicySha256",
      "turnGeneration",
      "turnId",
      "workspaceId",
    ],
    "tool call authority hash input",
    ["meshActivationGeneration", "meshPublisherGeneration"],
  );
  assertMcpRequesterAuthorityScope(input);
  for (const [field, value] of [
    ["finalProfileId", input.finalProfileId],
    ["serverId", input.serverId],
    ["resolverId", input.resolverId],
    ["profileDiscoveryAttemptId", input.profileDiscoveryAttemptId],
    ["revalidationAttemptId", input.revalidationAttemptId],
    ["finalEffectAttemptId", input.finalEffectAttemptId],
    ["rawRemoteToolName", input.rawRemoteToolName],
    ["canonicalToolName", input.canonicalToolName],
    ["providerAlias", input.providerAlias],
  ] as const) {
    assertCanonicalMcpIdentifier(value, field, 256);
  }
  if (!/^mcp__[a-f0-9]{64}$/u.test(input.providerAlias)) {
    throw new TypeError("MCP providerAlias must be an opaque full-digest alias.");
  }
  assertCanonicalSemVer(input.resolverVersion, "resolverVersion");
  assertMcpRequesterAuthorityGenerations(input);
  for (const [field, value] of [
    ["finalProfileSha256", input.finalProfileSha256],
    ["baseCallableCatalogSha256", input.baseCallableCatalogSha256],
    ["finalCallableCatalogSha256", input.finalCallableCatalogSha256],
    ["serverConfigSha256", input.serverConfigSha256],
    ["transportPolicySha256", input.transportPolicySha256],
    ["normalizedDiscoveryCatalogSha256", input.normalizedDiscoveryCatalogSha256],
    ["normalizedToolDefinitionSha256", input.normalizedToolDefinitionSha256],
    ["bindingSha256", input.bindingSha256],
  ] as const) {
    assertLowercaseSha256(value, field);
  }
  return {
    schemaVersion: MCP_TOOL_CALL_AUTHORITY_HASH_MATERIAL_VERSION,
    stage: "tool_call",
    ...input,
  };
}

export function mcpRequesterDiscoveryToolHashMaterial(
  input: McpRequesterDiscoveryToolHashInput,
): McpRequesterDiscoveryToolHashMaterial {
  assertExactObjectKeys(
    input,
    ["canonicalToolName", "description", "inputSchema", "rawRemoteToolName", "serverId"],
    "requester discovery tool hash input",
    ["description"],
  );
  assertCanonicalMcpIdentifier(input.serverId, "serverId", 256);
  assertCanonicalMcpIdentifier(input.rawRemoteToolName, "rawRemoteToolName", 256);
  assertCanonicalMcpIdentifier(input.canonicalToolName, "canonicalToolName", 256);
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new TypeError("MCP requester discovery description is invalid.");
  }
  if (typeof input.inputSchema !== "object" || input.inputSchema === null || Array.isArray(input.inputSchema)) {
    throw new TypeError("MCP requester discovery inputSchema must be an object.");
  }
  return { schemaVersion: MCP_REQUESTER_DISCOVERY_TOOL_HASH_MATERIAL_VERSION, ...input };
}

export function mcpRequesterDiscoveryCatalogHashMaterial(
  input: McpRequesterDiscoveryCatalogHashInput,
): McpRequesterDiscoveryCatalogHashMaterial {
  assertExactObjectKeys(input, ["secretScan", "serverId", "tools"], "requester discovery catalog hash input");
  assertCanonicalMcpIdentifier(input.serverId, "serverId", 256);
  assertMcpRequesterDiscoverySecretScanEvidence(input.secretScan);
  if (!Array.isArray(input.tools) || input.tools.length > MCP_REQUESTER_DISCOVERY_LIMITS.maxTools) {
    throw new TypeError("MCP requester discovery tools are invalid.");
  }
  for (const tool of input.tools) {
    assertExactObjectKeys(
      tool,
      ["canonicalToolName", "description", "inputSchema", "rawRemoteToolName", "toolDefinitionSha256"],
      "normalized requester discovery tool",
      ["description"],
    );
    mcpRequesterDiscoveryToolHashMaterial({
      serverId: input.serverId,
      rawRemoteToolName: tool.rawRemoteToolName,
      canonicalToolName: tool.canonicalToolName,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    });
    assertLowercaseSha256(tool.toolDefinitionSha256, "toolDefinitionSha256");
  }
  return { schemaVersion: MCP_REQUESTER_DISCOVERY_CATALOG_HASH_MATERIAL_VERSION, ...input };
}

export function mcpRequesterProviderAliasHashMaterial(
  input: McpRequesterProviderAliasHashInput,
): McpRequesterProviderAliasHashMaterial {
  assertExactObjectKeys(
    input,
    ["bindingSha256", "canonicalToolName", "normalizedToolDefinitionSha256", "rawRemoteToolName", "serverId"],
    "requester provider alias hash input",
  );
  for (const [field, value] of [
    ["serverId", input.serverId],
    ["rawRemoteToolName", input.rawRemoteToolName],
    ["canonicalToolName", input.canonicalToolName],
  ] as const) {
    assertCanonicalMcpIdentifier(value, field, 256);
  }
  assertLowercaseSha256(input.normalizedToolDefinitionSha256, "normalizedToolDefinitionSha256");
  assertLowercaseSha256(input.bindingSha256, "bindingSha256");
  return { schemaVersion: MCP_REQUESTER_PROVIDER_ALIAS_HASH_MATERIAL_VERSION, ...input };
}

export function assertMcpRequesterDiscoverySecretScanEvidence(
  input: unknown,
): asserts input is McpRequesterDiscoverySecretScanEvidence {
  assertExactObjectKeys(
    input,
    ["evidenceSha256", "scannedSha256", "scannerGeneration", "scannerId", "scannerVersion", "verdict"],
    "requester discovery secret scan",
  );
  const value = input as Record<string, unknown>;
  assertCanonicalMcpIdentifier(value.scannerId, "scannerId", 128);
  assertCanonicalSemVer(value.scannerVersion, "scannerVersion");
  assertPositiveSafeInteger(value.scannerGeneration, "scannerGeneration");
  assertLowercaseSha256(value.scannedSha256, "scannedSha256");
  assertLowercaseSha256(value.evidenceSha256, "evidenceSha256");
  if (value.verdict !== "clean") throw new TypeError("MCP requester discovery secret scan did not pass.");
}

function assertMcpRequesterAuthorityScope(input: {
  actorId: unknown;
  actorSource: unknown;
  workspaceId: unknown;
  sessionId: unknown;
  turnId: unknown;
}): void {
  assertCanonicalMcpIdentifier(input.actorId, "actorId", 256);
  assertCanonicalMcpIdentifier(input.workspaceId, "workspaceId", 256);
  assertCanonicalMcpIdentifier(input.sessionId, "sessionId", 256);
  assertCanonicalMcpIdentifier(input.turnId, "turnId", 256);
  if (
    input.actorSource !== "token" &&
    input.actorSource !== "basic" &&
    input.actorSource !== "loopback" &&
    input.actorSource !== "device" &&
    input.actorSource !== "companion"
  ) {
    throw new TypeError("MCP actorSource is not authenticated.");
  }
}

function assertMcpRequesterAuthorityGenerations(
  input: Record<string, unknown> & {
    meshPublisherGeneration?: number;
    meshActivationGeneration?: number;
  },
): void {
  for (const field of [
    "serverConfigRevision",
    "resolverConfigGeneration",
    "globalNetworkPolicyGeneration",
    "authConnectionGeneration",
    "turnGeneration",
    "preparationGeneration",
  ]) {
    assertPositiveSafeInteger(input[field], field);
  }
  const stageGenerationFields = [
    "discoveryAttemptGeneration",
    "profileDiscoveryAttemptGeneration",
    "revalidationAttemptGeneration",
    "finalEffectAttemptGeneration",
  ];
  for (const field of stageGenerationFields) {
    if (input[field] !== undefined) assertPositiveSafeInteger(input[field], field);
  }
  const hasPublisher = input.meshPublisherGeneration !== undefined;
  const hasActivation = input.meshActivationGeneration !== undefined;
  if (hasPublisher !== hasActivation) {
    throw new TypeError("MCP mesh authority generations must be present together.");
  }
  if (hasPublisher) {
    assertPositiveSafeInteger(input.meshPublisherGeneration, "meshPublisherGeneration");
    assertPositiveSafeInteger(input.meshActivationGeneration, "meshActivationGeneration");
  }
}

export function assertMcpRequesterResolutionConfig(input: unknown): asserts input is McpRequesterResolutionConfig {
  assertExactObjectKeys(
    input,
    ["configGeneration", "resolverId", "resolverVersion", "transportPolicy"],
    "requesterResolution",
  );
  const value = input as Record<string, unknown>;
  assertCanonicalMcpIdentifier(value.resolverId, "resolverId", 128);
  assertCanonicalSemVer(value.resolverVersion, "resolverVersion");
  assertPositiveSafeInteger(value.configGeneration, "configGeneration");
  assertExactObjectKeys(
    value.transportPolicy,
    ["allowedHeaderNames", "allowedHosts", "allowedPorts", "allowedSchemes"],
    "transportPolicy",
  );
  const policy = value.transportPolicy as Record<string, unknown>;
  assertAllowedSchemes(policy.allowedSchemes);
  assertAllowedHosts(policy.allowedHosts);
  assertAllowedPorts(policy.allowedPorts);
  assertAllowedHeaderNames(policy.allowedHeaderNames);
}

export function assertMcpRequesterResolutionBinding(input: unknown): asserts input is McpRequesterResolutionBinding {
  assertExactObjectKeys(
    input,
    [
      "bindingSha256",
      "callableCatalogSha256",
      "callableCatalogSnapshotId",
      "meshActivation",
      "mode",
      "requesterScopeSha256",
      "resolverConfigGeneration",
      "resolverId",
      "resolverVersion",
      "schemaVersion",
      "serverConfigRevision",
      "serverConfigSha256",
      "serverId",
      "toolName",
      "transportPolicySha256",
    ],
    "requester resolution binding",
    ["meshActivation"],
  );
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== MCP_REQUESTER_RESOLUTION_BINDING_VERSION || value.mode !== "requester_scoped") {
    throw new TypeError("MCP requester resolution binding version or mode is invalid.");
  }
  assertCanonicalMcpIdentifier(value.serverId, "serverId", 256);
  assertCanonicalMcpIdentifier(value.toolName, "toolName", 256);
  assertCanonicalMcpIdentifier(value.resolverId, "resolverId", 128);
  assertCanonicalSemVer(value.resolverVersion, "resolverVersion");
  assertPositiveSafeInteger(value.resolverConfigGeneration, "resolverConfigGeneration");
  assertPositiveSafeInteger(value.serverConfigRevision, "serverConfigRevision");
  assertCanonicalMcpIdentifier(value.callableCatalogSnapshotId, "callableCatalogSnapshotId", 256);
  for (const field of [
    "requesterScopeSha256",
    "serverConfigSha256",
    "transportPolicySha256",
    "callableCatalogSha256",
    "bindingSha256",
  ] as const) {
    assertLowercaseSha256(value[field], field);
  }
  if (value.meshActivation !== undefined) {
    assertMcpRequesterResolutionMeshBinding(value.meshActivation);
  }
}

export function mcpRequesterResolutionBindingHashMaterial(
  input: McpRequesterResolutionBinding,
): McpRequesterResolutionBindingMaterial {
  assertMcpRequesterResolutionBinding(input);
  const { bindingSha256: _bindingSha256, ...material } = input;
  return material;
}

function assertMcpRequesterResolutionMeshBinding(input: unknown): asserts input is McpRequesterResolutionMeshBinding {
  assertExactObjectKeys(
    input,
    [
      "activationId",
      "activationRevision",
      "descriptorSha256",
      "entrySha256",
      "healthGeneration",
      "manifestSha256",
      "publicationLeaseFencingToken",
      "publisherGeneration",
    ],
    "meshActivation",
  );
  const value = input as Record<string, unknown>;
  assertCanonicalMcpIdentifier(value.activationId, "meshActivation.activationId", 256);
  for (const field of [
    "activationRevision",
    "publisherGeneration",
    "healthGeneration",
    "publicationLeaseFencingToken",
  ] as const) {
    assertPositiveSafeInteger(value[field], `meshActivation.${field}`);
  }
  for (const field of ["manifestSha256", "entrySha256", "descriptorSha256"] as const) {
    assertLowercaseSha256(value[field], `meshActivation.${field}`);
  }
}

function assertExactObjectKeys(
  input: unknown,
  allowedKeys: readonly string[],
  field: string,
  optionalKeys: readonly string[] = [],
): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`MCP ${field} must be an object.`);
  }
  const keys = Object.keys(input).sort(compareExactMcpStrings);
  const allowed = new Set(allowedKeys);
  if (keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`MCP ${field} contains unsupported fields.`);
  }
  const optional = new Set(optionalKeys);
  if (allowedKeys.some((key) => !optional.has(key) && !keys.includes(key))) {
    throw new TypeError(`MCP ${field} is missing required fields.`);
  }
}

function assertCanonicalMcpIdentifier(input: unknown, field: string, maxLength: number): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > maxLength ||
    input !== input.normalize("NFKC").trim() ||
    /\s/u.test(input) ||
    containsAsciiControlCharacter(input) ||
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(input) ||
    input.includes("\\")
  ) {
    throw new TypeError(`MCP ${field} is not a canonical identifier.`);
  }
}

function assertCanonicalSemVer(input: unknown, field: string): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      input,
    )
  ) {
    throw new TypeError(`MCP ${field} must be a canonical SemVer value.`);
  }
}

function assertPositiveSafeInteger(input: unknown, field: string): asserts input is number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw new TypeError(`MCP ${field} must be a positive safe integer.`);
  }
}

function assertLowercaseSha256(input: unknown, field: string): asserts input is string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
    throw new TypeError(`MCP ${field} must be a lowercase sha256 digest.`);
  }
}

function assertAllowedSchemes(input: unknown): asserts input is Array<"http" | "https"> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
    throw new TypeError("MCP transportPolicy.allowedSchemes is invalid.");
  }
  for (const value of input) {
    if (value !== "http" && value !== "https") {
      throw new TypeError("MCP transportPolicy.allowedSchemes contains an invalid scheme.");
    }
  }
  assertStrictlySortedMcpStrings(input, "transportPolicy.allowedSchemes");
}

function assertAllowedHosts(input: unknown): asserts input is string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new TypeError("MCP transportPolicy.allowedHosts is invalid.");
  }
  for (const value of input) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 253 ||
      value !== value.normalize("NFKC").trim().toLowerCase() ||
      /\s/u.test(value) ||
      containsAsciiControlCharacter(value) ||
      value.includes("*")
    ) {
      throw new TypeError("MCP transportPolicy.allowedHosts must use lowercase canonical hosts.");
    }
    let parsed: URL;
    try {
      parsed = new URL(`https://${value}/`);
    } catch {
      throw new TypeError("MCP transportPolicy.allowedHosts contains an invalid host.");
    }
    if (parsed.hostname !== value || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
      throw new TypeError("MCP transportPolicy.allowedHosts must contain exact hosts only.");
    }
  }
  assertStrictlySortedMcpStrings(input, "transportPolicy.allowedHosts");
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertAllowedPorts(input: unknown): asserts input is number[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new TypeError("MCP transportPolicy.allowedPorts is invalid.");
  }
  let prior = 0;
  for (const value of input) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535 || value <= prior) {
      throw new TypeError("MCP transportPolicy.allowedPorts must be unique and sorted.");
    }
    prior = value;
  }
}

function assertAllowedHeaderNames(input: unknown): asserts input is string[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new TypeError("MCP transportPolicy.allowedHeaderNames is invalid.");
  }
  const forbidden = new Set([
    "connection",
    "content-length",
    "cookie",
    "forwarded",
    "host",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "proxy-authorization",
    "proxy-connection",
    "set-cookie",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const value of input) {
    if (
      typeof value !== "string" ||
      value !== value.normalize("NFKC").trim().toLowerCase() ||
      value.length < 1 ||
      value.length > 64 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(value) ||
      forbidden.has(value) ||
      value.startsWith("proxy-") ||
      value.startsWith("x-forwarded-")
    ) {
      throw new TypeError("MCP transportPolicy.allowedHeaderNames contains a forbidden name.");
    }
  }
  assertStrictlySortedMcpStrings(input, "transportPolicy.allowedHeaderNames");
}

function assertStrictlySortedMcpStrings(input: string[], field: string): void {
  for (let index = 1; index < input.length; index += 1) {
    if (compareExactMcpStrings(input[index]!, input[index - 1]!) <= 0) {
      throw new TypeError(`MCP ${field} must be unique and sorted by exact value.`);
    }
  }
}

function compareExactMcpStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface McpOAuthStartResponse {
  authorizeUrl: string;
  state: string;
}

export interface McpInvokeRequest {
  serverId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: PermissionSurface;
  autonomousActivation?: boolean;
  estimatedCostUsd?: number;
  policyContext?: ToolPolicyActorContext;
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
  signal?: AbortSignal;
}

export type McpNormalizedContentItem =
  | { type: "text"; text: string }
  | { type: "json"; data: unknown }
  | { type: "image"; mimeType?: string; data?: string; url?: string; resourceUri?: string; name?: string }
  | { type: "resource"; uri?: string; mimeType?: string; text?: string; blob?: string; name?: string }
  | { type: "error"; text: string };

export interface McpInvokeDiagnostics {
  transport: McpTransport;
  degraded?: boolean;
  retryCount?: number;
  sanitizedError?: string;
  externalOutcome?: "unknown_after_send";
  manualReconciliationRequired?: boolean;
}

export interface McpInvokeResponse {
  ok: boolean;
  output?: Record<string, unknown>;
  contentItems?: McpNormalizedContentItem[];
  diagnostics?: McpInvokeDiagnostics;
  autonomousActivation?: AutonomousActivationRuntimeEvidence;
  error?: string;
  externalOutcome?: "unknown_after_send";
  manualReconciliationRequired?: boolean;
  approvalRequired?: boolean;
  approvalId?: string;
  policyReason?: string;
  reasonCodes?: string[];
}

export const MCP_ELICITATION_LIMITS = {
  promptMaxChars: 4096,
  requestedSchemaMaxBytes: 16 * 1024,
  responseContentMaxBytes: 16 * 1024,
  listMaxItems: 200,
} as const;

export type McpElicitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";
export type McpElicitationResponseAction = "accept" | "decline" | "cancel";
export type McpElicitationSourceType = "mcp_server" | "gateway" | "agent" | "ui";

export interface McpElicitationBoundedTextBody {
  text: string;
  charLength: number;
  maxChars: number;
  truncated: boolean;
  redactedSecretCount: number;
}

export interface McpElicitationBoundedJsonBody<TValue = Record<string, unknown>> {
  value: TValue;
  byteLength: number;
  maxBytes: number;
  truncated: boolean;
  redactedSecretCount: number;
}

export interface McpElicitationOwnerMetadata {
  operatorId?: string;
  agentId?: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  surface?: PermissionSurface;
}

export interface McpElicitationSourceMetadata {
  sourceType: McpElicitationSourceType;
  serverId?: string;
  toolName?: string;
  jsonRpcRequestId?: string | number;
  transport?: McpTransport;
  sourceRef?: string;
}

export interface McpElicitationPolicyMetadata {
  redactionMode: "basic" | "strict";
  sensitiveInformationAllowed: false;
  requiresOperatorResponse: boolean;
  transportBoundary: "gateway_local_mcp";
  remoteTransportSupport: "unchanged";
  limits: typeof MCP_ELICITATION_LIMITS;
  governance: string[];
}

export interface McpElicitationAuditMetadata {
  auditEventIds: string[];
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  reasonCodes: string[];
}

export interface McpElicitationStatusEvidence {
  status: McpElicitationStatus;
  previousStatus?: McpElicitationStatus;
  reason: string;
  recordedAt: string;
  auditEventId: string;
}

export interface McpElicitationEvidence {
  owner: McpElicitationOwnerMetadata;
  source: McpElicitationSourceMetadata;
  status: McpElicitationStatus;
  createdAt: string;
  updatedAt: string;
  statusHistory: McpElicitationStatusEvidence[];
  prompt: Pick<McpElicitationBoundedTextBody, "charLength" | "maxChars" | "truncated" | "redactedSecretCount">;
  requestedSchema: Pick<McpElicitationBoundedJsonBody, "byteLength" | "maxBytes" | "truncated" | "redactedSecretCount">;
  responseContent?: Pick<
    McpElicitationBoundedJsonBody,
    "byteLength" | "maxBytes" | "truncated" | "redactedSecretCount"
  >;
}

export interface McpElicitationResponse {
  action: McpElicitationResponseAction;
  content?: McpElicitationBoundedJsonBody;
  owner: McpElicitationOwnerMetadata;
  respondedAt: string;
  audit: McpElicitationAuditMetadata;
  evidence: McpElicitationStatusEvidence;
}

export interface McpElicitationRequest {
  elicitationId: string;
  method: "elicitation/create";
  status: McpElicitationStatus;
  prompt: McpElicitationBoundedTextBody;
  requestedSchema: McpElicitationBoundedJsonBody;
  protocol: {
    method: "elicitation/create";
    message: string;
    requestedSchema: Record<string, unknown>;
  };
  owner: McpElicitationOwnerMetadata;
  source: McpElicitationSourceMetadata;
  policy: McpElicitationPolicyMetadata;
  audit: McpElicitationAuditMetadata;
  evidence: McpElicitationEvidence;
  response?: McpElicitationResponse;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomousActivationRuntimeEvidence {
  requested: boolean;
  allowed: boolean;
  matchedGrantId?: string;
  riskLevel?: import("./autonomy.js").AutonomousActivationRiskLevel;
  governance: string[];
  blockers: string[];
}

export interface McpTemplateDiscoveryResult {
  templateId: string;
  label: string;
  installed: boolean;
  readiness: "ready" | "needs_auth" | "needs_command" | "needs_url" | "unknown";
  dependencyChecks: Array<{
    key: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
}

export type McpRemotePreviewPosture =
  | "runtime_supported"
  | "configured_only"
  | "experimental_record_allowed"
  | "blocked";
export type McpRemotePreviewCallableState = "runtime_invokable" | "not_callable";
export type McpRemotePreviewRuntimePath = "internal_approval_inbox" | "generic_remote_http_sse";
export type McpRemotePreviewInvocationState =
  | "runtime_invokable"
  | "configured_not_callable"
  | "experimental_record_only"
  | "blocked"
  | "quarantined";

export interface McpRemotePreviewItem {
  source: "server" | "template";
  id: string;
  label: string;
  transport: Extract<McpTransport, "http" | "sse">;
  url?: string;
  authType: "none" | "token" | "oauth2";
  authReadiness: McpOAuthReadiness;
  trustTier: McpTrustTier;
  status?: McpServerStatus;
  enabled?: boolean;
  installed?: boolean;
  posture: McpRemotePreviewPosture;
  callableState: McpRemotePreviewCallableState;
  invocationState: McpRemotePreviewInvocationState;
  runtimePath: McpRemotePreviewRuntimePath;
  createAllowed: boolean;
  transportRuntimeSupported: boolean;
  runtimeSupported: boolean;
  operatorNextAction: string;
  blockers: string[];
  governance: string[];
  evidence: {
    policyNotes?: string;
    verifiedAt?: string;
    lastConnectedAt?: string;
    lastError?: string;
    authState?: McpServerAuthState;
  };
}

export interface McpRemotePreviewResponse {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  experimentalRemoteRecordsAllowed: boolean;
  runtimeSupport:
    | "internal_approval_inbox_only"
    | "remote_http_sse_bridge"
    | "experimental_records_only"
    | "not_available";
  summary: {
    remoteServers: number;
    remoteTemplates: number;
    runtimeSupported: number;
    blocked: number;
    configuredOnly: number;
    notCallable: number;
    experimentalRecords: number;
    quarantined: number;
    needsAuth: number;
  };
  items: McpRemotePreviewItem[];
}

export type McpServerModeStatus = "preview";
export type McpServerModeRuntimeSupport = "stdio_proxy" | "call_preview" | "manifest_only" | "not_available";
export type McpServerModeToolState = "call_preview" | "descriptor_only" | "blocked";

export interface McpServerModeToolDescriptor {
  name: string;
  title: string;
  description: string;
  capabilityId: string;
  capabilityKind: CapabilityKind;
  sourceRef?: string;
  inputSchema: Record<string, unknown>;
  gatewayCallable: boolean;
  serverModeState: McpServerModeToolState;
  blockers: string[];
  governance: string[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export interface McpServerModeManifestResponse {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  status: McpServerModeStatus;
  protocol: "mcp";
  runtimeSupport: McpServerModeRuntimeSupport;
  server: {
    name: "goatcitadel";
    label: string;
    version: string;
    transport: Extract<McpTransport, "stdio">;
  };
  launch: {
    supported: boolean;
    command?: string;
    args?: string[];
    reason: string;
  };
  runtime: {
    callPreview: {
      supported: boolean;
      endpoint: "/api/v1/mcp/server-mode/call";
      requiresGatewayAuth: true;
      readOnlyOnly: true;
      requiredCallContext: Array<"agentId" | "sessionId">;
      reason?: string;
    };
    stdio: {
      supported: boolean;
      command?: string;
      args?: string[];
      requiresGatewayAuth?: boolean;
      gatewayEndpoint?: "/api/v1/mcp/server-mode/manifest";
      reason: string;
    };
  };
  summary: {
    inspectableCapabilities: number;
    gatewayCallableCapabilities: number;
    exportedToolDescriptors: number;
    blockedDescriptors: number;
  };
  tools: McpServerModeToolDescriptor[];
  governance: string[];
  limitations: string[];
  evidence: {
    catalogScope: "callable";
    catalogSnapshot?: Pick<CapabilityCatalogEntry, "capabilityId" | "kind" | "callable">[];
  };
}

export interface McpServerModeCallRequest {
  descriptorName: string;
  args?: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

export interface McpServerModeCallResponse {
  readOnly: true;
  mutationSemantics: "governed_tool_invocation";
  descriptorName: string;
  capabilityId?: string;
  toolName?: string;
  outcome: "executed" | "approval_required" | "blocked";
  policyReason: string;
  auditEventId?: string;
  approvalId?: string;
  result?: Record<string, unknown>;
  governance: string[];
  limitations: string[];
  evidence: {
    serverModeState?: McpServerModeToolState;
    gatewayCallable?: boolean;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ConnectorDiagnosticReport {
  connectorType: "mcp_server" | "integration_connection";
  connectorId: string;
  status: "ok" | "warn" | "error";
  checks: Array<{
    key: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
  recommendedNextAction?: string;
  checkedAt: string;
  probe?: ChannelProbeReport;
}
