import type { StaticMcpCatalogSnapshot } from "./mcp-static-catalog.js";
import type { CapabilityCatalogEntry, ToolPolicyActorContext, McpRequesterScopeAuthActorSource, McpNormalizedRequesterDiscoveryCatalog, McpRequesterResolutionBinding } from "@goatcitadel/contracts";
import { collectNativeMcpChatCatalogCandidates, bindNativeStaticMcpChatToolSchema, resolveNativeMcpChatToolSchemas } from "./gateway/native-mcp-chat-catalog.js";
import type { ChatTurnCapabilityProfileResolveInput } from "./chat-turn-capability-profile-service.js";
import type { McpRequesterScopedCatalogDiscoveryHookInput, McpRequesterScopedCatalogFreezeHookInput } from "./mcp-requester-resolution-service.js";

interface McpProfileBindingPort {
  discoverMcpRequesterCatalogs?(
    input: McpRequesterScopedCatalogDiscoveryHookInput,
  ): Promise<McpNormalizedRequesterDiscoveryCatalog[]>;
  resolveMcpRequesterCatalogBindings?(
    input: McpRequesterScopedCatalogFreezeHookInput,
    options: { signal: AbortSignal },
  ): Promise<McpRequesterResolutionBinding[] | undefined>;
  discoverStaticMcpCatalogs?(input: McpRequesterScopedCatalogDiscoveryHookInput): Promise<StaticMcpCatalogSnapshot[]>;
  assertStaticMcpCatalogCurrent?(snapshot: StaticMcpCatalogSnapshot, input: McpRequesterScopedCatalogDiscoveryHookInput): Promise<void>;
}

export async function discoverChatMcpProfileCandidates(
  deps: McpProfileBindingPort,
  nativeAdmissionAllowed: boolean,
  discoveryHook: McpRequesterScopedCatalogDiscoveryHookInput,
  baseInspectableEntries: CapabilityCatalogEntry[],
) {
  const [requesterCatalogs, staticCatalogs] = await Promise.all([
    nativeAdmissionAllowed && deps.discoverMcpRequesterCatalogs && deps.resolveMcpRequesterCatalogBindings
      ? deps.discoverMcpRequesterCatalogs(discoveryHook) : [],
    nativeAdmissionAllowed && deps.discoverStaticMcpCatalogs && deps.assertStaticMcpCatalogCurrent
      ? deps.discoverStaticMcpCatalogs(discoveryHook) : [],
  ]);
  const nativeCandidates = collectNativeMcpChatCatalogCandidates(requesterCatalogs, baseInspectableEntries, staticCatalogs);
  return nativeCandidates;
}

export async function bindChatMcpProfileCandidates(
  deps: McpProfileBindingPort,
  nativeCandidates: ReturnType<typeof collectNativeMcpChatCatalogCandidates>,
  discoveryHook: McpRequesterScopedCatalogDiscoveryHookInput,
  input: Pick<ChatTurnCapabilityProfileResolveInput, "turnId" | "sessionId" | "workspaceId">,
  policyContext: ToolPolicyActorContext,
  capabilityProfileId: string,
  snapshotId: string,
  callableHash: string,
) {
  const nativeTools =
    nativeCandidates.length > 0 && deps.resolveMcpRequesterCatalogBindings
      ? await resolveNativeMcpChatToolSchemas(
          nativeCandidates.filter((candidate) => !candidate.staticCatalog),
          {
            ...discoveryHook,
            catalogSnapshotId: snapshotId,
            callableCatalogSha256: callableHash,
          },
          deps.resolveMcpRequesterCatalogBindings,
        )
      : [];
  for (const candidate of nativeCandidates) {
    if (!candidate.staticCatalog) continue;
    if (!deps.assertStaticMcpCatalogCurrent || !policyContext.authActorId ||
      !isMcpRequesterScopeAuthActorSource(policyContext.authActorSource)) throw new Error("Static MCP admission has no current actor authority.");
    await deps.assertStaticMcpCatalogCurrent(candidate.staticCatalog, discoveryHook);
    nativeTools.push(bindNativeStaticMcpChatToolSchema(candidate, {
      profileId: capabilityProfileId, turnId: input.turnId, sessionId: input.sessionId, workspaceId: input.workspaceId,
      authActorId: policyContext.authActorId, authActorSource: policyContext.authActorSource,
    }, { snapshotId, callableHash }));
  }
  return nativeTools;
}

export function isMcpRequesterScopeAuthActorSource(
  value: ToolPolicyActorContext["authActorSource"],
): value is McpRequesterScopeAuthActorSource {
  return value === "token" || value === "basic" || value === "loopback" || value === "device" || value === "companion";
}

