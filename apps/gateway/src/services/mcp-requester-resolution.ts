/* eslint-disable max-lines -- The two-stage authority seam is intentionally co-located and production-dark. */
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  MCP_REQUESTER_DISCOVERY_LIMITS,
  MCP_REQUESTER_DISCOVERY_OUTPUT_VERSION,
  assertMcpRequesterResolutionBinding,
  assertMcpRequesterResolutionConfig,
  canonicalJsonString,
  mcpProfileDiscoveryAuthorityHashMaterial,
  mcpRequesterDiscoveryCatalogHashMaterial,
  mcpRequesterDiscoveryToolHashMaterial,
  mcpRequesterProviderAliasHashMaterial,
  mcpRequesterResolutionBindingHashMaterial,
  mcpToolCallAuthorityHashMaterial,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpNormalizedRequesterDiscoveryTool,
  type McpProfileDiscoveryAuthorityHashInput,
  type McpRequesterResolutionBinding,
  type McpRequesterResolutionConfig,
  type McpRequesterResolutionTransportPolicy,
  type McpRequesterDiscoveryOutputInput,
  type McpRequesterDiscoverySecretScanEvidence,
  type McpToolCallAuthorityHashInput,
} from "@goatcitadel/contracts";

export const MCP_REQUESTER_RESOLUTION_TIMEOUT_MS = 2_000;
export const MCP_REQUESTER_CONNECTION_MAX_AGE_MS = 5 * 60_000;
export const MCP_REQUESTER_CONNECTION_URL_MAX_BYTES = 2_048;
export const MCP_REQUESTER_CONNECTION_HEADER_LIMIT = 16;
export const MCP_REQUESTER_CONNECTION_HEADER_NAME_MAX_BYTES = 64;
export const MCP_REQUESTER_CONNECTION_HEADER_VALUE_MAX_BYTES = 8_192;
export const MCP_REQUESTER_CONNECTION_HEADER_AGGREGATE_MAX_BYTES = 32_768;

export type McpRequesterResolutionReasonCode =
  | "requester_context_missing"
  | "requester_context_ambiguous"
  | "requester_scope_mismatch"
  | "capability_profile_missing"
  | "capability_profile_invalid"
  | "capability_profile_drift"
  | "server_not_callable"
  | "resolver_missing"
  | "resolver_binding_drift"
  | "resolver_timeout"
  | "resolver_cancelled"
  | "resolver_failed"
  | "discovery_output_invalid"
  | "discovery_output_too_large"
  | "discovery_secret_detected"
  | "schema_revalidation_required"
  | "schema_revalidation_drift"
  | "operation_denied"
  | "resolved_connection_invalid"
  | "resolved_destination_denied"
  | "resolved_header_denied"
  | "resolved_connection_expired"
  | "connection_generation_revoked"
  | "secret_guard_failed"
  | "transport_pre_dispatch_failed"
  | "transport_outcome_unknown";

const REASON_MESSAGES: Record<McpRequesterResolutionReasonCode, string> = {
  requester_context_missing: "Authenticated requester context is required.",
  requester_context_ambiguous: "Authenticated requester context is invalid.",
  requester_scope_mismatch: "Authenticated requester scope does not match.",
  capability_profile_missing: "The immutable capability profile is required.",
  capability_profile_invalid: "The immutable capability profile is invalid.",
  capability_profile_drift: "The immutable capability profile has drifted.",
  server_not_callable: "The MCP server is not callable.",
  resolver_missing: "The requester connection resolver is unavailable.",
  resolver_binding_drift: "The requester connection resolver binding has drifted.",
  resolver_timeout: "Requester connection resolution timed out.",
  resolver_cancelled: "Requester connection resolution was cancelled.",
  resolver_failed: "Requester connection resolution failed.",
  discovery_output_invalid: "The requester MCP discovery output is invalid.",
  discovery_output_too_large: "The requester MCP discovery output exceeds its bound.",
  discovery_secret_detected: "The requester MCP discovery output did not pass secret scanning.",
  schema_revalidation_required: "A fresh requester MCP schema revalidation is required.",
  schema_revalidation_drift: "The requester MCP schema revalidation has drifted.",
  operation_denied: "The requester MCP operation is denied for this authority stage.",
  resolved_connection_invalid: "The resolved MCP connection is invalid.",
  resolved_destination_denied: "The resolved MCP destination is denied.",
  resolved_header_denied: "A resolved MCP header is denied.",
  resolved_connection_expired: "The resolved MCP connection has expired.",
  connection_generation_revoked: "The resolved MCP connection generation is no longer current.",
  secret_guard_failed: "The requester connection secret guard failed.",
  transport_pre_dispatch_failed: "The MCP transport failed before dispatch.",
  transport_outcome_unknown: "The MCP transport outcome is unknown.",
};

export class McpRequesterResolutionError extends Error {
  public readonly code: McpRequesterResolutionReasonCode;

  public constructor(code: McpRequesterResolutionReasonCode) {
    super(REASON_MESSAGES[code]);
    this.name = "McpRequesterResolutionError";
    this.code = code;
  }
}

const profileDiscoveryAuthorityBrand: unique symbol = Symbol("goatcitadel.mcp.profile-discovery-authority");
const toolCallAuthorityBrand: unique symbol = Symbol("goatcitadel.mcp.tool-call-authority");
const sealedToolCallProfileBrand: unique symbol = Symbol("goatcitadel.mcp.sealed-tool-call-profile");
const authorityConstructionToken: unique symbol = Symbol("goatcitadel.mcp.private-authority-construction");
const profileDiscoveryAuthorities = new WeakSet<object>();
const toolCallAuthorities = new WeakSet<object>();
const sealedToolCallProfiles = new WeakSet<object>();

export interface McpProfileDiscoveryAuthority extends Readonly<McpProfileDiscoveryAuthorityHashInput> {
  readonly stage: "profile_discovery";
  readonly authoritySha256: string;
  readonly [profileDiscoveryAuthorityBrand]: true;
  toJSON(): never;
}

class McpProfileDiscoveryAuthorityValue {
  public constructor(
    token: typeof authorityConstructionToken,
    material: ReturnType<typeof mcpProfileDiscoveryAuthorityHashMaterial>,
  ) {
    if (token !== authorityConstructionToken) throw new McpRequesterResolutionError("requester_context_ambiguous");
    Object.assign(this, material, { authoritySha256: digest(material) });
    profileDiscoveryAuthorities.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

function createMcpProfileDiscoveryAuthority(
  input: McpProfileDiscoveryAuthorityHashInput,
): McpProfileDiscoveryAuthority {
  try {
    const snapshot = snapshotExactOwnDataRecord(
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
      ["meshActivationGeneration", "meshPublisherGeneration"],
    );
    const material = mcpProfileDiscoveryAuthorityHashMaterial(
      snapshot as unknown as McpProfileDiscoveryAuthorityHashInput,
    );
    return new McpProfileDiscoveryAuthorityValue(
      authorityConstructionToken,
      material,
    ) as unknown as McpProfileDiscoveryAuthority;
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

export function assertMcpProfileDiscoveryAuthority(input: unknown): asserts input is McpProfileDiscoveryAuthority {
  if (typeof input !== "object" || input === null || !profileDiscoveryAuthorities.has(input)) {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

export interface McpRequesterProviderAliasInput {
  serverId: string;
  rawRemoteToolName: string;
  canonicalToolName: string;
  normalizedToolDefinitionSha256: string;
  bindingSha256: string;
}

interface McpSealedToolCallProfileInput extends McpRequesterProviderAliasInput {
  finalProfileId: string;
  finalProfileSha256: string;
  baseCallableCatalogSha256: string;
  finalCallableCatalogSha256: string;
  providerAlias: string;
  normalizedDiscoveryCatalogSha256: string;
}

interface McpSealedToolCallProfile extends Readonly<McpSealedToolCallProfileInput> {
  readonly [sealedToolCallProfileBrand]: true;
  toJSON(): never;
}

class McpSealedToolCallProfileValue {
  public constructor(token: typeof authorityConstructionToken, value: Readonly<McpSealedToolCallProfileInput>) {
    if (token !== authorityConstructionToken) throw new McpRequesterResolutionError("capability_profile_invalid");
    Object.assign(this, value);
    sealedToolCallProfiles.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

export function createMcpRequesterProviderAlias(input: McpRequesterProviderAliasInput): string {
  let material: ReturnType<typeof mcpRequesterProviderAliasHashMaterial>;
  try {
    const snapshot = snapshotExactOwnDataRecord(input, [
      "bindingSha256",
      "canonicalToolName",
      "normalizedToolDefinitionSha256",
      "rawRemoteToolName",
      "serverId",
    ]);
    material = mcpRequesterProviderAliasHashMaterial(snapshot as never);
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
  return `mcp__${digest(material)}`;
}

function createMcpSealedToolCallProfile(input: McpSealedToolCallProfileInput): McpSealedToolCallProfile {
  let value: Readonly<McpSealedToolCallProfileInput>;
  try {
    value = snapshotExactOwnDataRecord(input, [
      "baseCallableCatalogSha256",
      "bindingSha256",
      "canonicalToolName",
      "finalCallableCatalogSha256",
      "finalProfileId",
      "finalProfileSha256",
      "normalizedDiscoveryCatalogSha256",
      "normalizedToolDefinitionSha256",
      "providerAlias",
      "rawRemoteToolName",
      "serverId",
    ]) as unknown as Readonly<McpSealedToolCallProfileInput>;
    for (const identifier of [
      value.finalProfileId,
      value.serverId,
      value.rawRemoteToolName,
      value.canonicalToolName,
      value.providerAlias,
    ]) {
      assertCanonicalIdentifier(identifier, 256);
    }
    for (const hash of [
      value.finalProfileSha256,
      value.baseCallableCatalogSha256,
      value.finalCallableCatalogSha256,
      value.normalizedDiscoveryCatalogSha256,
      value.normalizedToolDefinitionSha256,
      value.bindingSha256,
    ]) {
      assertLowercaseSha256(hash);
    }
    const expectedAlias = createMcpRequesterProviderAlias({
      serverId: value.serverId,
      rawRemoteToolName: value.rawRemoteToolName,
      canonicalToolName: value.canonicalToolName,
      normalizedToolDefinitionSha256: value.normalizedToolDefinitionSha256,
      bindingSha256: value.bindingSha256,
    });
    if (expectedAlias !== value.providerAlias) throw new TypeError();
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
  return new McpSealedToolCallProfileValue(authorityConstructionToken, value) as unknown as McpSealedToolCallProfile;
}

function assertMcpSealedToolCallProfile(input: unknown): asserts input is McpSealedToolCallProfile {
  if (typeof input !== "object" || input === null || !sealedToolCallProfiles.has(input)) {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

interface McpToolCallAuthorityInput extends Omit<
  McpToolCallAuthorityHashInput,
  | "finalProfileId"
  | "finalProfileSha256"
  | "baseCallableCatalogSha256"
  | "finalCallableCatalogSha256"
  | "serverId"
  | "rawRemoteToolName"
  | "canonicalToolName"
  | "providerAlias"
  | "normalizedDiscoveryCatalogSha256"
  | "normalizedToolDefinitionSha256"
  | "bindingSha256"
> {
  sealedProfile: McpSealedToolCallProfile;
}

export interface McpToolCallAuthority extends Readonly<McpToolCallAuthorityHashInput> {
  readonly stage: "tool_call";
  readonly authoritySha256: string;
  readonly [toolCallAuthorityBrand]: true;
  toJSON(): never;
}

class McpToolCallAuthorityValue {
  public constructor(
    token: typeof authorityConstructionToken,
    material: ReturnType<typeof mcpToolCallAuthorityHashMaterial>,
  ) {
    if (token !== authorityConstructionToken) throw new McpRequesterResolutionError("requester_context_ambiguous");
    Object.assign(this, material, { authoritySha256: digest(material) });
    toolCallAuthorities.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

function createMcpToolCallAuthority(input: McpToolCallAuthorityInput): McpToolCallAuthority {
  try {
    const snapshot = snapshotExactOwnDataRecord(
      input,
      [
        "actorId",
        "actorSource",
        "authConnectionGeneration",
        "finalEffectAttemptGeneration",
        "finalEffectAttemptId",
        "globalNetworkPolicyGeneration",
        "meshActivationGeneration",
        "meshPublisherGeneration",
        "preparationGeneration",
        "profileDiscoveryAttemptGeneration",
        "profileDiscoveryAttemptId",
        "resolverConfigGeneration",
        "resolverId",
        "resolverVersion",
        "revalidationAttemptGeneration",
        "revalidationAttemptId",
        "sealedProfile",
        "serverConfigRevision",
        "serverConfigSha256",
        "sessionId",
        "transportPolicySha256",
        "turnGeneration",
        "turnId",
        "workspaceId",
      ],
      ["meshActivationGeneration", "meshPublisherGeneration"],
    );
    assertMcpSealedToolCallProfile(snapshot.sealedProfile);
    const profile = snapshot.sealedProfile;
    const material = mcpToolCallAuthorityHashMaterial({
      actorId: snapshot.actorId,
      actorSource: snapshot.actorSource,
      workspaceId: snapshot.workspaceId,
      sessionId: snapshot.sessionId,
      turnId: snapshot.turnId,
      finalProfileId: profile.finalProfileId,
      finalProfileSha256: profile.finalProfileSha256,
      baseCallableCatalogSha256: profile.baseCallableCatalogSha256,
      finalCallableCatalogSha256: profile.finalCallableCatalogSha256,
      serverId: profile.serverId,
      serverConfigRevision: snapshot.serverConfigRevision,
      serverConfigSha256: snapshot.serverConfigSha256,
      resolverId: snapshot.resolverId,
      resolverVersion: snapshot.resolverVersion,
      resolverConfigGeneration: snapshot.resolverConfigGeneration,
      transportPolicySha256: snapshot.transportPolicySha256,
      globalNetworkPolicyGeneration: snapshot.globalNetworkPolicyGeneration,
      authConnectionGeneration: snapshot.authConnectionGeneration,
      turnGeneration: snapshot.turnGeneration,
      preparationGeneration: snapshot.preparationGeneration,
      ...(snapshot.meshPublisherGeneration === undefined
        ? {}
        : {
            meshPublisherGeneration: snapshot.meshPublisherGeneration,
            meshActivationGeneration: snapshot.meshActivationGeneration,
          }),
      profileDiscoveryAttemptId: snapshot.profileDiscoveryAttemptId,
      profileDiscoveryAttemptGeneration: snapshot.profileDiscoveryAttemptGeneration,
      revalidationAttemptId: snapshot.revalidationAttemptId,
      revalidationAttemptGeneration: snapshot.revalidationAttemptGeneration,
      finalEffectAttemptId: snapshot.finalEffectAttemptId,
      finalEffectAttemptGeneration: snapshot.finalEffectAttemptGeneration,
      rawRemoteToolName: profile.rawRemoteToolName,
      canonicalToolName: profile.canonicalToolName,
      providerAlias: profile.providerAlias,
      normalizedDiscoveryCatalogSha256: profile.normalizedDiscoveryCatalogSha256,
      normalizedToolDefinitionSha256: profile.normalizedToolDefinitionSha256,
      bindingSha256: profile.bindingSha256,
    } as McpToolCallAuthorityHashInput);
    return new McpToolCallAuthorityValue(authorityConstructionToken, material) as unknown as McpToolCallAuthority;
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

// Deliberately production-dark: these constructors are retained only inside
// this lexical owner. A separately reviewed auth/profile integration must call
// them from server-owned state before requester-scoped MCP can become live.
Object.freeze(createMcpProfileDiscoveryAuthority);
Object.freeze(createMcpSealedToolCallProfile);
Object.freeze(createMcpToolCallAuthority);

export function assertMcpToolCallAuthority(input: unknown): asserts input is McpToolCallAuthority {
  if (typeof input !== "object" || input === null || !toolCallAuthorities.has(input)) {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

export interface McpRequesterScopedServerSnapshot {
  serverId: string;
  transport: "http" | "sse";
  connectionMode: "requester_scoped";
  configurationRevision: number;
  requesterResolution: McpRequesterResolutionConfig;
}

export interface McpProfileDiscoveryCurrentState {
  revoked: boolean;
  actorId: string;
  actorSource: McpProfileDiscoveryAuthority["actorSource"];
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
  discoveryAttemptOpen: boolean;
  connectionGenerationCurrent: boolean;
  rotationGenerationCurrent: boolean;
}

export interface McpToolCallCurrentState {
  revoked: boolean;
  actorId: string;
  actorSource: McpToolCallAuthority["actorSource"];
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
  finalEffectAttemptOpen: boolean;
  rawRemoteToolName: string;
  canonicalToolName: string;
  providerAlias: string;
  normalizedDiscoveryCatalogSha256: string;
  normalizedToolDefinitionSha256: string;
  bindingSha256: string;
  connectionGenerationCurrent: boolean;
  rotationGenerationCurrent: boolean;
}

export interface McpProfileDiscoveryConnectionResolverInput {
  serverId: string;
  requester: McpProfileDiscoveryAuthority;
  signal: AbortSignal;
}

export interface McpToolCallConnectionResolverInput {
  serverId: string;
  requester: McpToolCallAuthority;
  binding: McpRequesterResolutionBinding;
  signal: AbortSignal;
}

export interface McpEphemeralResolvedHeaderInput {
  name: string;
  value: string;
}

export interface McpEphemeralResolvedConnectionInput {
  outcomeClass: "resolved";
  url: string;
  headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
  connectionGeneration: number;
  rotationGeneration?: number;
  expiresAt: string;
}

const resolvedConnectionCandidateBrand: unique symbol = Symbol("goatcitadel.mcp.resolved-connection-candidate");
const readResolvedConnectionCandidate: unique symbol = Symbol("goatcitadel.mcp.read-resolved-connection-candidate");

export interface McpEphemeralResolvedConnectionCandidate {
  readonly [resolvedConnectionCandidateBrand]: true;
  toJSON(): never;
}

class McpEphemeralResolvedConnectionCandidateValue implements McpEphemeralResolvedConnectionCandidate {
  declare public readonly [resolvedConnectionCandidateBrand]: true;
  #value: Readonly<McpEphemeralResolvedConnectionInput> | undefined;

  public constructor(value: McpEphemeralResolvedConnectionInput) {
    this.#value = Object.freeze({
      outcomeClass: value.outcomeClass,
      url: value.url,
      headers: value.headers,
      connectionGeneration: value.connectionGeneration,
      ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
      expiresAt: value.expiresAt,
    });
    Object.freeze(this);
  }

  public [readResolvedConnectionCandidate](): McpEphemeralResolvedConnectionInput {
    const value = this.#value;
    if (!value) throw new McpRequesterResolutionError("resolved_connection_invalid");
    this.#value = undefined;
    return {
      ...value,
      headers: value.headers.map((header) => ({ ...header })),
    };
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }
}

export function createMcpEphemeralResolvedConnectionCandidate(
  input: McpEphemeralResolvedConnectionInput,
): McpEphemeralResolvedConnectionCandidate {
  try {
    return new McpEphemeralResolvedConnectionCandidateValue(snapshotResolvedConnectionInput(input));
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
}

for (const prototype of [
  McpProfileDiscoveryAuthorityValue.prototype,
  McpToolCallAuthorityValue.prototype,
  McpSealedToolCallProfileValue.prototype,
]) {
  Object.defineProperty(prototype, "constructor", {
    value: undefined,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  Object.freeze(prototype);
}
Object.freeze(McpEphemeralResolvedConnectionCandidateValue.prototype);

export function readMcpEphemeralResolvedConnectionCandidate(input: unknown): McpEphemeralResolvedConnectionInput {
  if (!(input instanceof McpEphemeralResolvedConnectionCandidateValue)) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  return input[readResolvedConnectionCandidate]();
}

export interface McpProfileDiscoveryConnectionResolver {
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly configGeneration: number;
  resolveForProfileDiscovery(
    input: McpProfileDiscoveryConnectionResolverInput,
  ): Promise<McpEphemeralResolvedConnectionCandidate>;
}

export interface McpToolCallConnectionResolver {
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly configGeneration: number;
  resolveForToolCall(input: McpToolCallConnectionResolverInput): Promise<McpEphemeralResolvedConnectionCandidate>;
}

type StableMcpProfileDiscoveryConnectionResolver = McpProfileDiscoveryConnectionResolver;
type StableMcpToolCallConnectionResolver = McpToolCallConnectionResolver;

export interface McpRequesterResolverRegistryInput {
  profileDiscovery: readonly McpProfileDiscoveryConnectionResolver[];
  toolCall: readonly McpToolCallConnectionResolver[];
}

export class McpRequesterResolverRegistry {
  readonly #profileDiscoveryById: ReadonlyMap<string, StableMcpProfileDiscoveryConnectionResolver>;
  readonly #toolCallById: ReadonlyMap<string, StableMcpToolCallConnectionResolver>;

  public constructor(input: McpRequesterResolverRegistryInput) {
    let snapshot: Readonly<Record<string, unknown>>;
    try {
      snapshot = snapshotExactOwnDataRecord(input, ["profileDiscovery", "toolCall"]);
    } catch {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    this.#profileDiscoveryById = freezeResolverPortRegistry<StableMcpProfileDiscoveryConnectionResolver>(
      snapshot.profileDiscovery,
      "resolveForProfileDiscovery",
    );
    this.#toolCallById = freezeResolverPortRegistry<StableMcpToolCallConnectionResolver>(
      snapshot.toolCall,
      "resolveForToolCall",
    );
  }

  public resolveProfileDiscoveryExact(
    resolverId: string,
    resolverVersion: string,
    configGeneration: number,
  ): StableMcpProfileDiscoveryConnectionResolver {
    const resolver = this.#profileDiscoveryById.get(resolverId);
    if (!resolver) throw new McpRequesterResolutionError("resolver_missing");
    if (resolver.resolverVersion !== resolverVersion || resolver.configGeneration !== configGeneration) {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    return resolver;
  }

  public resolveToolCallExact(
    resolverId: string,
    resolverVersion: string,
    configGeneration: number,
  ): StableMcpToolCallConnectionResolver {
    const resolver = this.#toolCallById.get(resolverId);
    if (!resolver) throw new McpRequesterResolutionError("resolver_missing");
    if (resolver.resolverVersion !== resolverVersion || resolver.configGeneration !== configGeneration) {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    return resolver;
  }

  public listMetadata(): Array<{
    stage: "profile_discovery" | "tool_call";
    resolverId: string;
    resolverVersion: string;
    configGeneration: number;
  }> {
    return [
      ...[...this.#profileDiscoveryById.values()].map((resolver) => ({
        stage: "profile_discovery" as const,
        ...resolverMetadata(resolver),
      })),
      ...[...this.#toolCallById.values()].map((resolver) => ({
        stage: "tool_call" as const,
        ...resolverMetadata(resolver),
      })),
    ].sort((left, right) => {
      const byId = compareExact(left.resolverId, right.resolverId);
      return byId === 0 ? compareExact(left.stage, right.stage) : byId;
    });
  }
}

function freezeResolverPortRegistry<
  TResolver extends { resolverId: string; resolverVersion: string; configGeneration: number },
>(input: unknown, method: "resolveForProfileDiscovery" | "resolveForToolCall"): ReadonlyMap<string, TResolver> {
  let entries: readonly unknown[];
  try {
    entries = snapshotExactArray(input, 64);
  } catch {
    throw new McpRequesterResolutionError("resolver_binding_drift");
  }
  const byId = new Map<string, TResolver>();
  for (const resolver of entries) {
    try {
      const snapshot = snapshotExactOwnDataRecord(resolver, [
        "configGeneration",
        method,
        "resolverId",
        "resolverVersion",
      ]);
      assertCanonicalIdentifier(snapshot.resolverId, 128);
      assertCanonicalSemVer(snapshot.resolverVersion);
      assertPositiveSafeInteger(snapshot.configGeneration);
      const implementation = snapshot[method];
      if (typeof implementation !== "function" || nodeTypes.isProxy(implementation) || byId.has(snapshot.resolverId)) {
        throw new TypeError();
      }
      const stable = Object.freeze({
        resolverId: snapshot.resolverId,
        resolverVersion: snapshot.resolverVersion,
        configGeneration: snapshot.configGeneration,
        [method]: implementation.bind(undefined),
      }) as unknown as TResolver;
      byId.set(stable.resolverId, stable);
    } catch {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
  }
  return byId;
}

function resolverMetadata(input: { resolverId: string; resolverVersion: string; configGeneration: number }): {
  resolverId: string;
  resolverVersion: string;
  configGeneration: number;
} {
  return {
    resolverId: input.resolverId,
    resolverVersion: input.resolverVersion,
    configGeneration: input.configGeneration,
  };
}

export interface ValidatedMcpEphemeralResolvedConnection {
  outcomeClass: "resolved";
  url: string;
  headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
  connectionGeneration: number;
  rotationGeneration?: number;
  expiresAt: string;
  expiresAtMs: number;
}

export function assertMcpRequesterScopedServerSnapshot(
  input: unknown,
): asserts input is McpRequesterScopedServerSnapshot {
  snapshotMcpRequesterScopedServerSnapshot(input);
}

export function snapshotMcpRequesterScopedServerSnapshot(input: unknown): McpRequesterScopedServerSnapshot {
  try {
    const value = snapshotExactOwnDataRecord(input, [
      "configurationRevision",
      "connectionMode",
      "requesterResolution",
      "serverId",
      "transport",
    ]);
    const requesterResolution = snapshotExactOwnDataRecord(value.requesterResolution, [
      "configGeneration",
      "resolverId",
      "resolverVersion",
      "transportPolicy",
    ]);
    const transportPolicy = snapshotExactOwnDataRecord(requesterResolution.transportPolicy, [
      "allowedHeaderNames",
      "allowedHosts",
      "allowedPorts",
      "allowedSchemes",
    ]);
    const safeResolution = Object.freeze({
      resolverId: requesterResolution.resolverId,
      resolverVersion: requesterResolution.resolverVersion,
      configGeneration: requesterResolution.configGeneration,
      transportPolicy: Object.freeze({
        allowedSchemes: Object.freeze([...snapshotExactArray(transportPolicy.allowedSchemes, 2)]),
        allowedHosts: Object.freeze([...snapshotExactArray(transportPolicy.allowedHosts, 64)]),
        allowedPorts: Object.freeze([...snapshotExactArray(transportPolicy.allowedPorts, 64)]),
        allowedHeaderNames: Object.freeze([...snapshotExactArray(transportPolicy.allowedHeaderNames, 64)]),
      }),
    });
    const snapshot = Object.freeze({
      serverId: value.serverId,
      transport: value.transport,
      connectionMode: value.connectionMode,
      configurationRevision: value.configurationRevision,
      requesterResolution: safeResolution,
    });
    assertCanonicalIdentifier(snapshot.serverId, 256);
    if (snapshot.transport !== "http" && snapshot.transport !== "sse") throw new TypeError();
    if (snapshot.connectionMode !== "requester_scoped") throw new TypeError();
    assertPositiveSafeInteger(snapshot.configurationRevision);
    assertMcpRequesterResolutionConfig(snapshot.requesterResolution);
    return snapshot as McpRequesterScopedServerSnapshot;
  } catch {
    throw new McpRequesterResolutionError("server_not_callable");
  }
}

export function mcpRequesterScopedServerConfigHash(input: McpRequesterScopedServerSnapshot): string {
  return digest(snapshotMcpRequesterScopedServerSnapshot(input));
}

export function mcpRequesterTransportPolicyHash(input: McpRequesterResolutionTransportPolicy): string {
  assertMcpRequesterResolutionConfig({
    resolverId: "goatcitadel.policy-hash",
    resolverVersion: "1.0.0",
    configGeneration: 1,
    transportPolicy: input,
  });
  return digest(input);
}

export function mcpRequesterMeshActivationHash(binding: McpRequesterResolutionBinding): string | undefined {
  assertMcpRequesterResolutionBinding(binding);
  return binding.meshActivation ? digest(binding.meshActivation) : undefined;
}

export function assertMcpRequesterResolutionBindingIntegrity(binding: McpRequesterResolutionBinding): void {
  try {
    assertMcpRequesterResolutionBinding(binding);
    if (digest(mcpRequesterResolutionBindingHashMaterial(binding)) !== binding.bindingSha256) throw new TypeError();
  } catch {
    throw new McpRequesterResolutionError("capability_profile_invalid");
  }
}

export interface McpRequesterDiscoverySecretScannerInput {
  serverId: string;
  canonicalPayload: string;
  payloadSha256: string;
}

export interface McpRequesterDiscoverySecretScannerResult {
  verdict: "clean";
  evidenceSha256: string;
}

export interface McpRequesterDiscoverySecretScanner {
  scannerId: string;
  scannerVersion: string;
  scannerGeneration: number;
  scan(input: Readonly<McpRequesterDiscoverySecretScannerInput>): McpRequesterDiscoverySecretScannerResult;
}

const normalizedDiscoveryCatalogs = new WeakSet<object>();

/**
 * Snapshot, bound, deterministically sorted discovery output. This is the only
 * structural entrypoint for discovery or fresh schema-revalidation evidence.
 */
export function normalizeMcpRequesterDiscoveryOutput(
  serverId: string,
  input: McpRequesterDiscoveryOutputInput,
  scanner: McpRequesterDiscoverySecretScanner,
): McpNormalizedRequesterDiscoveryCatalog {
  try {
    assertCanonicalIdentifier(serverId, 256);
    const root = snapshotExactOwnDataRecord(input, ["tools"]);
    const entries = snapshotExactArray(
      root.tools,
      MCP_REQUESTER_DISCOVERY_LIMITS.maxTools,
      () => new McpRequesterResolutionError("discovery_output_too_large"),
    );
    const tools: McpNormalizedRequesterDiscoveryTool[] = [];
    const rawNames = new Set<string>();
    const canonicalNames = new Set<string>();
    let aggregateNodes = 0;
    for (const entry of entries) {
      const value = snapshotExactOwnDataRecord(
        entry,
        ["canonicalToolName", "description", "inputSchema", "rawRemoteToolName"],
        ["description"],
      );
      assertCanonicalIdentifier(value.rawRemoteToolName, 256);
      assertCanonicalIdentifier(value.canonicalToolName, 256);
      if (rawNames.has(value.rawRemoteToolName) || canonicalNames.has(value.canonicalToolName)) {
        throw new McpRequesterResolutionError("discovery_output_invalid");
      }
      rawNames.add(value.rawRemoteToolName);
      canonicalNames.add(value.canonicalToolName);
      let description: string | undefined;
      if (value.description !== undefined) {
        if (
          typeof value.description !== "string" ||
          value.description !== value.description.normalize("NFKC").trim() ||
          containsAsciiControlCharacter(value.description) ||
          Buffer.byteLength(value.description, "utf8") > MCP_REQUESTER_DISCOVERY_LIMITS.maxDescriptionBytes
        ) {
          throw new McpRequesterResolutionError("discovery_output_invalid");
        }
        description = value.description;
      }
      const schema = snapshotBoundedJsonObject(value.inputSchema);
      aggregateNodes += schema.nodes;
      if (aggregateNodes > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaNodesAggregate) {
        throw new McpRequesterResolutionError("discovery_output_too_large");
      }
      const schemaBytes = Buffer.byteLength(canonicalJsonString(schema.value), "utf8");
      if (schemaBytes > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaBytesPerTool) {
        throw new McpRequesterResolutionError("discovery_output_too_large");
      }
      const material = mcpRequesterDiscoveryToolHashMaterial({
        serverId,
        rawRemoteToolName: value.rawRemoteToolName,
        canonicalToolName: value.canonicalToolName,
        ...(description === undefined ? {} : { description }),
        inputSchema: schema.value,
      });
      tools.push(
        Object.freeze({
          rawRemoteToolName: value.rawRemoteToolName,
          canonicalToolName: value.canonicalToolName,
          ...(description === undefined ? {} : { description }),
          inputSchema: schema.value,
          toolDefinitionSha256: digest(material),
        }),
      );
    }
    tools.sort((left, right) => {
      const byRaw = compareExact(left.rawRemoteToolName, right.rawRemoteToolName);
      return byRaw === 0 ? compareExact(left.canonicalToolName, right.canonicalToolName) : byRaw;
    });
    const frozenTools = Object.freeze([...tools]) as McpNormalizedRequesterDiscoveryTool[];
    const scanPayload = Object.freeze({
      schemaVersion: MCP_REQUESTER_DISCOVERY_OUTPUT_VERSION,
      serverId,
      tools: frozenTools,
    });
    const canonicalPayload = canonicalJsonString(scanPayload);
    if (Buffer.byteLength(canonicalPayload, "utf8") > MCP_REQUESTER_DISCOVERY_LIMITS.maxAggregateBytes) {
      throw new McpRequesterResolutionError("discovery_output_too_large");
    }
    const payloadSha256 = digest(scanPayload);
    const secretScan = runDiscoverySecretScan(scanner, {
      serverId,
      canonicalPayload,
      payloadSha256,
    });
    const material = mcpRequesterDiscoveryCatalogHashMaterial({ serverId, secretScan, tools: frozenTools });
    const catalog = Object.freeze({
      schemaVersion: MCP_REQUESTER_DISCOVERY_OUTPUT_VERSION,
      serverId,
      secretScan,
      tools: frozenTools,
      catalogSha256: digest(material),
    }) satisfies McpNormalizedRequesterDiscoveryCatalog;
    normalizedDiscoveryCatalogs.add(catalog);
    return catalog;
  } catch (error) {
    if (error instanceof McpRequesterResolutionError) throw error;
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
}

export function assertNormalizedMcpRequesterDiscoveryCatalog(
  input: unknown,
): asserts input is McpNormalizedRequesterDiscoveryCatalog {
  if (typeof input !== "object" || input === null || !normalizedDiscoveryCatalogs.has(input)) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
}

function runDiscoverySecretScan(
  scannerInput: McpRequesterDiscoverySecretScanner,
  input: McpRequesterDiscoverySecretScannerInput,
): McpRequesterDiscoverySecretScanEvidence {
  const scanner = snapshotExactOwnDataRecord(scannerInput, [
    "scan",
    "scannerGeneration",
    "scannerId",
    "scannerVersion",
  ]);
  assertCanonicalIdentifier(scanner.scannerId, 128);
  assertCanonicalSemVer(scanner.scannerVersion);
  assertPositiveSafeInteger(scanner.scannerGeneration);
  if (typeof scanner.scan !== "function" || nodeTypes.isProxy(scanner.scan)) {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }
  const result = snapshotExactOwnDataRecord(scanner.scan(Object.freeze({ ...input })), ["evidenceSha256", "verdict"]);
  if (result.verdict !== "clean") throw new McpRequesterResolutionError("discovery_secret_detected");
  assertLowercaseSha256(result.evidenceSha256);
  return Object.freeze({
    scannerId: scanner.scannerId,
    scannerVersion: scanner.scannerVersion,
    scannerGeneration: scanner.scannerGeneration,
    scannedSha256: input.payloadSha256,
    evidenceSha256: result.evidenceSha256,
    verdict: "clean",
  });
}

export function validateMcpEphemeralResolvedConnection(
  input: unknown,
  transportPolicy: McpRequesterResolutionTransportPolicy,
  nowMs: number,
): ValidatedMcpEphemeralResolvedConnection {
  let value: McpEphemeralResolvedConnectionInput;
  try {
    value = snapshotResolvedConnectionInput(input);
  } catch (error) {
    if (error instanceof McpRequesterResolutionError && error.code === "resolved_header_denied") throw error;
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  if (value.outcomeClass !== "resolved") {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  assertPositiveConnectionGeneration(value.connectionGeneration);
  if (value.rotationGeneration !== undefined) assertPositiveConnectionGeneration(value.rotationGeneration);
  const validatedUrl = validateResolvedUrl(value.url, transportPolicy);
  const headers = validateResolvedHeaders(value.headers, transportPolicy);
  const expiresAt = validateResolvedExpiry(value.expiresAt, nowMs);
  return Object.freeze({
    outcomeClass: "resolved",
    url: validatedUrl,
    headers,
    connectionGeneration: value.connectionGeneration,
    ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
    expiresAt: expiresAt.canonical,
    expiresAtMs: expiresAt.epochMs,
  });
}

function validateResolvedUrl(input: unknown, policy: McpRequesterResolutionTransportPolicy): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input !== input.trim() ||
    Buffer.byteLength(input, "utf8") > MCP_REQUESTER_CONNECTION_URL_MAX_BYTES ||
    containsAsciiControlCharacter(input) ||
    input.includes("\\") ||
    input.includes("#")
  ) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const scheme = parsed.protocol.slice(0, -1);
  if ((scheme !== "http" && scheme !== "https") || parsed.username || parsed.password || parsed.hash) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  if (
    !policy.allowedSchemes.includes(scheme) ||
    !policy.allowedHosts.includes(host) ||
    !policy.allowedPorts.includes(port)
  ) {
    throw new McpRequesterResolutionError("resolved_destination_denied");
  }
  if (scheme === "http" && !isExactLoopbackHost(host)) {
    throw new McpRequesterResolutionError("resolved_destination_denied");
  }
  return input;
}

function validateResolvedHeaders(
  input: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>,
  policy: McpRequesterResolutionTransportPolicy,
): ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>> {
  if (input.length > MCP_REQUESTER_CONNECTION_HEADER_LIMIT) {
    throw new McpRequesterResolutionError("resolved_header_denied");
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
  const seen = new Set<string>();
  const validated: Array<Readonly<McpEphemeralResolvedHeaderInput>> = [];
  let aggregateBytes = 0;
  for (const entry of input) {
    const { name, value } = entry;
    if (
      typeof name !== "string" ||
      name !== name.normalize("NFKC") ||
      Buffer.byteLength(name, "utf8") > MCP_REQUESTER_CONNECTION_HEADER_NAME_MAX_BYTES ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    const canonicalName = name.toLowerCase();
    if (
      seen.has(canonicalName) ||
      forbidden.has(canonicalName) ||
      canonicalName.startsWith("proxy-") ||
      canonicalName.startsWith("x-forwarded-") ||
      !policy.allowedHeaderNames.includes(canonicalName)
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      containsAsciiControlCharacter(value) ||
      Buffer.byteLength(value, "utf8") > MCP_REQUESTER_CONNECTION_HEADER_VALUE_MAX_BYTES
    ) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    aggregateBytes += Buffer.byteLength(canonicalName, "utf8") + Buffer.byteLength(value, "utf8") + 4;
    if (aggregateBytes > MCP_REQUESTER_CONNECTION_HEADER_AGGREGATE_MAX_BYTES) {
      throw new McpRequesterResolutionError("resolved_header_denied");
    }
    seen.add(canonicalName);
    validated.push(Object.freeze({ name: canonicalName, value }));
  }
  return Object.freeze(validated);
}

function validateResolvedExpiry(input: unknown, nowMs: number): { canonical: string; epochMs: number } {
  if (typeof input !== "string" || !Number.isFinite(nowMs)) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  const epochMs = Date.parse(input);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== input) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  if (epochMs <= nowMs) throw new McpRequesterResolutionError("resolved_connection_expired");
  if (epochMs > nowMs + MCP_REQUESTER_CONNECTION_MAX_AGE_MS) {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
  return { canonical: input, epochMs };
}

function assertPositiveConnectionGeneration(input: unknown): asserts input is number {
  try {
    assertPositiveSafeInteger(input);
  } catch {
    throw new McpRequesterResolutionError("resolved_connection_invalid");
  }
}

function isExactLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function snapshotResolvedConnectionInput(input: unknown): McpEphemeralResolvedConnectionInput {
  const value = snapshotExactOwnDataRecord(
    input,
    ["connectionGeneration", "expiresAt", "headers", "outcomeClass", "rotationGeneration", "url"],
    ["rotationGeneration"],
  );
  const headerEntries = snapshotExactArray(
    value.headers,
    MCP_REQUESTER_CONNECTION_HEADER_LIMIT,
    () => new McpRequesterResolutionError("resolved_header_denied"),
  );
  const headers = Object.freeze(
    headerEntries.map((header) => {
      const snapshot = snapshotExactOwnDataRecord(header, ["name", "value"]);
      return Object.freeze({ name: snapshot.name, value: snapshot.value }) as Readonly<McpEphemeralResolvedHeaderInput>;
    }),
  );
  return Object.freeze({
    outcomeClass: value.outcomeClass,
    url: value.url,
    headers,
    connectionGeneration: value.connectionGeneration,
    ...(value.rotationGeneration === undefined ? {} : { rotationGeneration: value.rotationGeneration }),
    expiresAt: value.expiresAt,
  }) as McpEphemeralResolvedConnectionInput;
}

function snapshotExactOwnDataRecord(
  input: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || nodeTypes.isProxy(input))
    throw new TypeError();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) throw new TypeError();
  const actualKeys = (actual as string[]).sort(compareExact);
  const allowed = new Set(keys);
  const optionalSet = new Set(optional);
  if (actualKeys.some((key) => !allowed.has(key))) throw new TypeError();
  if (keys.some((key) => !optionalSet.has(key) && !actualKeys.includes(key))) throw new TypeError();
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actualKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotExactArray(input: unknown, maxLength: number, onLimit?: () => Error): readonly unknown[] {
  if (!Array.isArray(input) || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor)) throw new TypeError();
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError();
  if (length > maxLength) throw onLimit?.() ?? new TypeError();
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) throw new TypeError();
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new TypeError();
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function snapshotBoundedJsonObject(input: unknown): { value: Record<string, unknown>; nodes: number } {
  const state = { nodes: 0, bytes: 0 };
  const value = snapshotBoundedJsonValue(input, 1, state);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
  return { value: value as Record<string, unknown>, nodes: state.nodes };
}

function snapshotBoundedJsonValue(input: unknown, depth: number, state: { nodes: number; bytes: number }): unknown {
  if (depth > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaDepth) {
    throw new McpRequesterResolutionError("discovery_output_too_large");
  }
  state.nodes += 1;
  if (state.nodes > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaNodesPerTool) {
    throw new McpRequesterResolutionError("discovery_output_too_large");
  }
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new McpRequesterResolutionError("discovery_output_invalid");
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaBytesPerTool) {
      throw new McpRequesterResolutionError("discovery_output_too_large");
    }
    if (input !== input.normalize("NFKC") || containsAsciiControlCharacter(input)) {
      throw new McpRequesterResolutionError("discovery_output_invalid");
    }
    state.bytes += Buffer.byteLength(input, "utf8");
    if (state.bytes > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaBytesPerTool) {
      throw new McpRequesterResolutionError("discovery_output_too_large");
    }
    return input;
  }
  if (typeof input !== "object" || input === null || nodeTypes.isProxy(input)) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
  if (Array.isArray(input)) {
    const values = snapshotExactArray(
      input,
      MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaNodesPerTool,
      () => new McpRequesterResolutionError("discovery_output_too_large"),
    );
    return Object.freeze(values.map((value) => snapshotBoundedJsonValue(value, depth + 1, state)));
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of (keys as string[]).sort(compareExact)) {
    if (key.length > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaBytesPerTool) {
      throw new McpRequesterResolutionError("discovery_output_too_large");
    }
    if (key !== key.normalize("NFKC") || containsAsciiControlCharacter(key)) {
      throw new McpRequesterResolutionError("discovery_output_invalid");
    }
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MCP_REQUESTER_DISCOVERY_LIMITS.maxSchemaBytesPerTool) {
      throw new McpRequesterResolutionError("discovery_output_too_large");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      throw new McpRequesterResolutionError("discovery_output_invalid");
    }
    output[key] = snapshotBoundedJsonValue(descriptor.value, depth + 1, state);
  }
  return Object.freeze(output);
}

function assertCanonicalIdentifier(input: unknown, maxLength: number): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > maxLength ||
    input !== input.normalize("NFKC").trim() ||
    containsAsciiControlCharacter(input) ||
    /[\s\\]/u.test(input) ||
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(input)
  ) {
    throw new TypeError();
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertCanonicalSemVer(input: unknown): asserts input is string {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      input,
    )
  ) {
    throw new TypeError();
  }
}

function assertPositiveSafeInteger(input: unknown): asserts input is number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) throw new TypeError();
}

function assertLowercaseSha256(input: unknown): asserts input is string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw new TypeError();
}

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
