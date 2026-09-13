import {
  classifyToolEffectPotential,
  type CapabilityCatalogEntry,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpNormalizedRequesterDiscoveryTool,
  type McpRequesterResolutionBinding,
  type McpRequesterScopeHashInput,
  type McpStaticToolBinding,
} from "@goatcitadel/contracts";
import { createMcpToolPolicyBinding, type McpToolPolicyBinding } from "@goatcitadel/policy-engine";
import {
  assertMcpRequesterResolutionBindingIntegrity,
  assertNormalizedMcpRequesterDiscoveryCatalog,
  createMcpRequesterProviderAlias,
} from "../mcp-requester-resolution.js";
import type {
  McpRequesterScopedCatalogDiscoveryHookInput,
  McpRequesterScopedCatalogFreezeHookInput,
} from "../mcp-requester-resolution-service.js";
import { assertStaticMcpCatalogSnapshot, bindStaticMcpCatalogTool, staticMcpProviderDefinition,
  type StaticMcpCatalogSnapshot } from "../mcp-static-catalog.js";

export interface NativeMcpChatCatalogCandidate {
  readonly serverId: string;
  readonly tool: McpNormalizedRequesterDiscoveryTool;
  readonly entry: CapabilityCatalogEntry;
  readonly staticCatalog?: StaticMcpCatalogSnapshot;
}

/** App-private admission data. The policy handle must never enter a profile or DTO. */
export interface NativeMcpChatToolSchema {
  readonly canonicalName: string;
  readonly modelName: string;
  readonly providerDefinition: Record<string, unknown>;
  readonly candidate: NativeMcpChatCatalogCandidate;
  readonly requesterBinding?: McpRequesterResolutionBinding;
  readonly staticBinding?: McpStaticToolBinding;
  readonly policyBinding: McpToolPolicyBinding;
}

const candidates = new WeakSet<object>();
const schemas = new WeakSet<object>();
export const NATIVE_MCP_CHAT_CATALOG_LIMIT = 256;

/**
 * Catalogs must originate in the secret-scanning owner in this process. Native
 * names never replace a registered capability, and ambiguous dotted names are
 * excluded on both sides instead of selecting whichever server was listed first.
 */
export function collectNativeMcpChatCatalogCandidates(
  catalogs: readonly McpNormalizedRequesterDiscoveryCatalog[],
  existingEntries: readonly CapabilityCatalogEntry[],
  staticCatalogs: readonly StaticMcpCatalogSnapshot[] = [],
): NativeMcpChatCatalogCandidate[] {
  for (const snapshot of staticCatalogs) assertStaticMcpCatalogSnapshot(snapshot);
  const sources = [
    ...catalogs.map((catalog) => ({ catalog, staticCatalog: undefined as StaticMcpCatalogSnapshot | undefined })),
    ...staticCatalogs.map((staticCatalog) => ({ catalog: staticCatalog.catalog, staticCatalog })),
  ];
  const reservedNames = new Set(existingEntries.flatMap((entry) => (entry.toolName ? [entry.toolName] : [])));
  const reservedIds = new Set(existingEntries.map((entry) => entry.capabilityId));
  const counts = new Map<string, number>();
  for (const { catalog } of sources) {
    assertNormalizedMcpRequesterDiscoveryCatalog(catalog);
    for (const tool of catalog.tools) counts.set(tool.canonicalToolName, (counts.get(tool.canonicalToolName) ?? 0) + 1);
  }
  const result: NativeMcpChatCatalogCandidate[] = [];
  for (const { catalog, staticCatalog } of sources) {
    for (const tool of catalog.tools) {
      const name = tool.canonicalToolName;
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name) ||
        name === "mcp.invoke" ||
        name !== `mcp.${catalog.serverId}.${tool.rawRemoteToolName}` ||
        counts.get(name) !== 1 ||
        reservedNames.has(name) ||
        reservedIds.has(`tool:${name}`)
      )
        continue;
      const candidate: NativeMcpChatCatalogCandidate = Object.freeze({
        serverId: catalog.serverId,
        tool,
        ...(staticCatalog ? { staticCatalog } : {}),
        entry: Object.freeze({
          capabilityId: `tool:${name}`,
          kind: "tool",
          category: "optional",
          title: tool.rawRemoteToolName,
          summary: (tool.description ?? "MCP tool.").slice(0, 1000),
          callable: true,
          toolName: name,
          trustLabel: staticCatalog ? "static_mcp" : "requester_scoped",
          sourceRef: `mcp-tool-definition:${tool.toolDefinitionSha256}`,
          wrapperVisibility: Object.freeze({ readOnly: false, deterministic: false, codeModeAllowed: false }),
          effectPotential: Object.freeze(
            classifyToolEffectPotential({ toolName: name, trustedBuiltin: false, sourceKind: "mcp" }),
          ),
        }),
      });
      candidates.add(candidate);
      result.push(candidate);
    }
  }
  result.sort((left, right) => left.tool.canonicalToolName.localeCompare(right.tool.canonicalToolName));
  // Share the bounded admission inventory across servers. A large server must
  // not consume the entire catalog before a smaller server gets a candidate.
  const byServer = new Map<string, NativeMcpChatCatalogCandidate[]>();
  for (const candidate of result) {
    const group = byServer.get(candidate.serverId) ?? [];
    group.push(candidate);
    byServer.set(candidate.serverId, group);
  }
  const selected: NativeMcpChatCatalogCandidate[] = [];
  for (let index = 0; selected.length < Math.min(result.length, NATIVE_MCP_CHAT_CATALOG_LIMIT); index += 1) {
    for (const group of byServer.values()) {
      if (group[index] && selected.length < NATIVE_MCP_CHAT_CATALOG_LIMIT) selected.push(group[index]!);
    }
  }
  return selected.sort((left, right) => left.tool.canonicalToolName.localeCompare(right.tool.canonicalToolName));
}

/** Complete the schema only after the final-catalog discovery matched its pinned descriptor. */
export function bindNativeMcpChatToolSchema(
  candidate: NativeMcpChatCatalogCandidate,
  binding: McpRequesterResolutionBinding,
): NativeMcpChatToolSchema {
  if (!candidates.has(candidate)) throw new Error("Native MCP catalog candidate is not server-owned");
  if (candidate.staticCatalog) throw new Error("Static MCP tools require their static configuration binding.");
  assertMcpRequesterResolutionBindingIntegrity(binding);
  if (binding.serverId !== candidate.serverId || binding.toolName !== candidate.tool.canonicalToolName) {
    throw new Error("Native MCP schema does not match its frozen requester binding");
  }
  const modelName = createMcpRequesterProviderAlias({
    serverId: candidate.serverId,
    rawRemoteToolName: candidate.tool.rawRemoteToolName,
    canonicalToolName: candidate.tool.canonicalToolName,
    normalizedToolDefinitionSha256: candidate.tool.toolDefinitionSha256,
    bindingSha256: binding.bindingSha256,
  });
  const schema = Object.freeze({
    canonicalName: candidate.tool.canonicalToolName,
    modelName,
    candidate,
    requesterBinding: Object.freeze({
      ...binding,
      ...(binding.meshActivation ? { meshActivation: Object.freeze({ ...binding.meshActivation }) } : {}),
    }),
    providerDefinition: Object.freeze({
      type: "function",
      function: Object.freeze({
        name: modelName,
        ...(candidate.tool.description ? { description: candidate.tool.description } : {}),
        parameters: candidate.tool.inputSchema,
      }),
    }),
    policyBinding: createMcpToolPolicyBinding({
      canonicalName: candidate.tool.canonicalToolName,
      serverId: candidate.serverId,
      nativeToolName: candidate.tool.rawRemoteToolName,
    }),
  });
  schemas.add(schema);
  return schema;
}

export function assertNativeMcpChatToolSchema(schema: NativeMcpChatToolSchema): void {
  if (!schemas.has(schema)) throw new Error("Native MCP schema is not server-owned");
}

export function bindNativeStaticMcpChatToolSchema(
  candidate: NativeMcpChatCatalogCandidate,
  scope: McpRequesterScopeHashInput,
  catalog: { snapshotId: string; callableHash: string },
): NativeMcpChatToolSchema {
  if (!candidates.has(candidate) || !candidate.staticCatalog) throw new Error("Static MCP candidate is not server-owned.");
  const providerDefinition = staticMcpProviderDefinition(candidate.staticCatalog, candidate.tool);
  const schema = Object.freeze({ canonicalName: candidate.tool.canonicalToolName,
    modelName: providerDefinition.function.name, providerDefinition, candidate,
    staticBinding: bindStaticMcpCatalogTool(candidate.staticCatalog, candidate.tool, scope, catalog),
    policyBinding: createMcpToolPolicyBinding({ canonicalName: candidate.tool.canonicalToolName,
      serverId: candidate.serverId, nativeToolName: candidate.tool.rawRemoteToolName }) });
  schemas.add(schema);
  return schema;
}

/** Final discovery runs once per server, bounded by concurrency and a shared deadline. */
export async function resolveNativeMcpChatToolSchemas(
  selected: readonly NativeMcpChatCatalogCandidate[],
  hook: McpRequesterScopedCatalogDiscoveryHookInput,
  resolveBindings: (
    input: McpRequesterScopedCatalogFreezeHookInput,
    options: { signal: AbortSignal },
  ) => Promise<McpRequesterResolutionBinding[] | undefined>,
): Promise<NativeMcpChatToolSchema[]> {
  const grouped = new Map<string, NativeMcpChatCatalogCandidate[]>();
  for (const candidate of selected) {
    if (!candidates.has(candidate)) throw new Error("Native MCP catalog candidate is not server-owned");
    const group = grouped.get(candidate.serverId) ?? [];
    group.push(candidate);
    grouped.set(candidate.serverId, group);
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30_000);
  deadline.unref();
  const result: NativeMcpChatToolSchema[] = [];
  try {
    const groups = [...grouped.entries()];
    for (let offset = 0; offset < groups.length && !controller.signal.aborted; offset += 4) {
      const batch = await Promise.all(
        groups.slice(offset, offset + 4).map(async ([serverId, group]) => {
          const bindings = await resolveBindings(
            {
              ...hook,
              serverId,
              tools: group.map(({ tool }) => ({
                canonicalToolName: tool.canonicalToolName,
                expectedToolDefinitionSha256: tool.toolDefinitionSha256,
              })),
            },
            { signal: controller.signal },
          );
          if (!bindings) return [];
          const byName = new Map(bindings.map((binding) => [binding.toolName, binding]));
          if (byName.size !== group.length || bindings.length !== group.length) {
            throw new Error("Native MCP discovery returned an incomplete binding batch");
          }
          return group.map((candidate) => {
            const binding = byName.get(candidate.tool.canonicalToolName);
            if (
              !binding ||
              binding.callableCatalogSnapshotId !== hook.catalogSnapshotId ||
              binding.callableCatalogSha256 !== hook.callableCatalogSha256 ||
              binding.requesterScopeSha256 !== hook.requesterScopeSha256
            ) {
              throw new Error("Native MCP discovery returned a different profile binding");
            }
            return bindNativeMcpChatToolSchema(candidate, binding);
          });
        }),
      );
      result.push(...batch.flat());
    }
  } finally {
    clearTimeout(deadline);
  }
  return result;
}
