import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  mcpRequesterAdmissionConnectionSchema,
  mcpRequesterAdmissionScopeSchema,
  mcpRequesterDiscoveryToolHashMaterial,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpRequesterAdmissionConnection,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolutionError,
  assertNormalizedMcpRequesterDiscoveryCatalog,
  createMcpRequesterProviderAlias,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  snapshotMcpRequesterScopedServerSnapshot,
  type McpRequesterScopedServerSnapshot,
} from "./mcp-requester-resolution.js";

export interface McpRequesterAdmissionCurrentState {
  scope: McpRequesterAdmissionScope;
  connectionId: string;
  generation: number;
  rotationGeneration?: number;
  server: McpRequesterScopedServerSnapshot;
  revoked: boolean;
  /** Exact canonical feature reference hash, required after the immutable admission binding exists. */
  referenceSha256?: string;
}

interface AdmissionAuthorityBase {
  readonly kind: "admission_discovery" | "admission_tool_call";
  readonly scope: Readonly<McpRequesterAdmissionScope>;
  readonly connectionId: string;
  readonly generation: number;
  readonly rotationGeneration?: number;
  readonly serverId: string;
  readonly serverConfigRevision: number;
  readonly serverConfigSha256: string;
  readonly transportPolicySha256: string;
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly resolverConfigGeneration: number;
  readonly authoritySha256: string;
  toJSON(): never;
}
export interface McpAdmissionDiscoveryAuthority extends AdmissionAuthorityBase {
  readonly kind: "admission_discovery";
  readonly discoveryAttemptId: string;
}
export interface McpAdmissionToolCallAuthority extends AdmissionAuthorityBase {
  readonly kind: "admission_tool_call";
  readonly referenceSha256: string;
  readonly bindingId: string;
  readonly rawRemoteToolName: string;
  readonly canonicalToolName: string;
  readonly providerAlias: string;
  readonly normalizedDiscoveryCatalogSha256: string;
  readonly normalizedToolDefinitionSha256: string;
  readonly revalidationAttemptId: string;
  readonly revalidationAttemptGeneration: number;
  readonly finalEffectAttemptId: string;
  readonly finalEffectAttemptGeneration: number;
}

const discoveryAuthorities = new WeakSet<object>();
const callAuthorities = new WeakSet<object>();
const HASH = /^[a-f0-9]{64}$/u;
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");

function stateMaterial(state: McpRequesterAdmissionCurrentState) {
  const scope = mcpRequesterAdmissionScopeSchema.parse(state.scope);
  const server = snapshotMcpRequesterScopedServerSnapshot(state.server);
  if (
    state.revoked ||
    !state.connectionId ||
    state.connectionId.length > 512 ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    (state.rotationGeneration !== undefined &&
      (!Number.isSafeInteger(state.rotationGeneration) || state.rotationGeneration < 0))
  ) {
    throw new McpRequesterResolutionError("connection_generation_revoked");
  }
  return {
    scope,
    connectionId: state.connectionId,
    generation: state.generation,
    ...(state.rotationGeneration === undefined ? {} : { rotationGeneration: state.rotationGeneration }),
    serverId: server.serverId,
    serverConfigRevision: server.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(server),
    transportPolicySha256: mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy),
    resolverId: server.requesterResolution.resolverId,
    resolverVersion: server.requesterResolution.resolverVersion,
    resolverConfigGeneration: server.requesterResolution.configGeneration,
  };
}

function frozenAuthority<T extends AdmissionAuthorityBase>(
  value: Omit<T, "toJSON" | "authoritySha256">,
  registry: WeakSet<object>,
): T {
  const result = {
    ...value,
    scope: Object.freeze({ ...value.scope }),
    authoritySha256: digest(value),
    toJSON(): never {
      throw new McpRequesterResolutionError("requester_context_ambiguous");
    },
  } as T;
  registry.add(result);
  return Object.freeze(result);
}

/** No whole capability profile or profile-like identifier is constructed for new Chat. */
export function issueMcpAdmissionDiscoveryAuthority(
  state: McpRequesterAdmissionCurrentState,
): McpAdmissionDiscoveryAuthority {
  return frozenAuthority<McpAdmissionDiscoveryAuthority>(
    {
      ...stateMaterial(state),
      kind: "admission_discovery",
      discoveryAttemptId: randomUUID(),
    },
    discoveryAuthorities,
  );
}

export function issueMcpAdmissionToolCallAuthority(input: {
  receipt: McpRequesterAdmissionConnection;
  canonicalToolName: string;
  referenceSha256: string;
  current: McpRequesterAdmissionCurrentState;
}): McpAdmissionToolCallAuthority {
  const receipt = assertMcpRequesterAdmissionConnection(input.receipt);
  const selected = receipt.selectedTools.find((tool) => tool.canonicalToolName === input.canonicalToolName);
  if (
    !selected ||
    !HASH.test(input.referenceSha256) ||
    input.current.referenceSha256 !== input.referenceSha256 ||
    canonicalJsonString(stateMaterial(input.current)) !== canonicalJsonString(receiptStateMaterial(receipt))
  ) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  return frozenAuthority<McpAdmissionToolCallAuthority>(
    {
      ...stateMaterial(input.current),
      kind: "admission_tool_call",
      referenceSha256: input.referenceSha256,
      bindingId: receipt.bindingId,
      rawRemoteToolName: selected.rawRemoteToolName,
      canonicalToolName: selected.canonicalToolName,
      providerAlias: selected.modelName,
      normalizedDiscoveryCatalogSha256: receipt.schemaHash,
      normalizedToolDefinitionSha256: selected.toolDefinitionSha256,
      revalidationAttemptId: randomUUID(),
      revalidationAttemptGeneration: 1,
      finalEffectAttemptId: randomUUID(),
      finalEffectAttemptGeneration: 1,
    },
    callAuthorities,
  );
}

export function assertMcpAdmissionAuthority(
  value: McpAdmissionDiscoveryAuthority | McpAdmissionToolCallAuthority,
  kind: "admission_discovery" | "admission_tool_call",
): void {
  if (
    !value ||
    typeof value !== "object" ||
    value.kind !== kind ||
    !(kind === "admission_discovery" ? discoveryAuthorities : callAuthorities).has(value)
  ) {
    throw new McpRequesterResolutionError("requester_context_ambiguous");
  }
}

/** Called before resolution and at each transport permit; revocation and generation changes win. */
export function assertMcpAdmissionCurrent(
  authority: McpAdmissionDiscoveryAuthority | McpAdmissionToolCallAuthority,
  state: McpRequesterAdmissionCurrentState,
  connectionGeneration?: number,
  rotationGeneration?: number,
): void {
  assertMcpAdmissionAuthority(authority, authority.kind);
  const current = stateMaterial(state);
  const original = receiptStateMaterial(authority);
  if (
    canonicalJsonString(current) !== canonicalJsonString(original) ||
    (authority.kind === "admission_tool_call" && state.referenceSha256 !== authority.referenceSha256) ||
    (connectionGeneration !== undefined && connectionGeneration !== authority.generation) ||
    (connectionGeneration !== undefined && rotationGeneration !== authority.rotationGeneration)
  ) {
    throw new McpRequesterResolutionError("connection_generation_revoked");
  }
}

function receiptStateMaterial(
  receipt: Pick<
    McpRequesterAdmissionConnection,
    | "scope"
    | "connectionId"
    | "generation"
    | "rotationGeneration"
    | "serverId"
    | "serverConfigRevision"
    | "serverConfigSha256"
    | "transportPolicySha256"
    | "resolverId"
    | "resolverVersion"
    | "resolverConfigGeneration"
  >,
) {
  const {
    scope,
    connectionId,
    generation,
    rotationGeneration,
    serverId,
    serverConfigRevision,
    serverConfigSha256,
    transportPolicySha256,
    resolverId,
    resolverVersion,
    resolverConfigGeneration,
  } = receipt;
  return {
    scope,
    connectionId,
    generation,
    ...(rotationGeneration === undefined ? {} : { rotationGeneration }),
    serverId,
    serverConfigRevision,
    serverConfigSha256,
    transportPolicySha256,
    resolverId,
    resolverVersion,
    resolverConfigGeneration,
  };
}
function bindingMaterial(receipt: Omit<McpRequesterAdmissionConnection, "bindingId">) {
  return { ...receipt, selectedTools: receipt.selectedTools.map(({ modelName: _modelName, ...tool }) => tool) };
}

export function createMcpRequesterAdmissionConnection(input: {
  current: McpRequesterAdmissionCurrentState;
  catalog: McpNormalizedRequesterDiscoveryCatalog;
  selectedToolNames: readonly string[];
}): McpRequesterAdmissionConnection {
  assertNormalizedMcpRequesterDiscoveryCatalog(input.catalog);
  const current = stateMaterial(input.current);
  if (input.catalog.serverId !== current.serverId) throw new McpRequesterResolutionError("requester_scope_mismatch");
  const names = new Set(input.selectedToolNames);
  const selectedTools = input.catalog.tools
    .filter((tool) => names.has(tool.canonicalToolName))
    .map((tool) => ({ ...structuredClone(tool), modelName: "pending" }))
    .sort((a, b) => a.canonicalToolName.localeCompare(b.canonicalToolName));
  if (selectedTools.length !== names.size || selectedTools.length < 1 || selectedTools.length > 16) {
    throw new McpRequesterResolutionError("discovery_output_invalid");
  }
  const base = {
    version: "mcp.requester.admission.v1" as const,
    ...current,
    schemaHash: input.catalog.catalogSha256,
    selectedTools,
  };
  const bindingId = digest(bindingMaterial(base));
  return assertMcpRequesterAdmissionConnection({
    ...base,
    bindingId,
    selectedTools: selectedTools.map((tool) => ({
      ...tool,
      modelName: createMcpRequesterProviderAlias({
        serverId: current.serverId,
        rawRemoteToolName: tool.rawRemoteToolName,
        canonicalToolName: tool.canonicalToolName,
        normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
        bindingSha256: bindingId,
      }),
    })),
  });
}

/** Rehydrate only nonsecret evidence. Current canonical admission/connection reads remain mandatory. */
export function assertMcpRequesterAdmissionConnection(value: unknown): McpRequesterAdmissionConnection {
  const receipt = mcpRequesterAdmissionConnectionSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 65_536)
    throw new McpRequesterResolutionError("discovery_output_too_large");
  const { bindingId, ...material } = receipt;
  if (digest(bindingMaterial(material)) !== bindingId) throw new McpRequesterResolutionError("resolver_binding_drift");
  for (const tool of receipt.selectedTools) {
    if (
      digest(
        mcpRequesterDiscoveryToolHashMaterial({
          serverId: receipt.serverId,
          rawRemoteToolName: tool.rawRemoteToolName,
          canonicalToolName: tool.canonicalToolName,
          inputSchema: tool.inputSchema,
          ...(tool.description === undefined ? {} : { description: tool.description }),
        }),
      ) !== tool.toolDefinitionSha256 ||
      createMcpRequesterProviderAlias({
        serverId: receipt.serverId,
        rawRemoteToolName: tool.rawRemoteToolName,
        canonicalToolName: tool.canonicalToolName,
        normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
        bindingSha256: bindingId,
      }) !== tool.modelName
    ) {
      throw new McpRequesterResolutionError("schema_revalidation_drift");
    }
  }
  return receipt;
}
