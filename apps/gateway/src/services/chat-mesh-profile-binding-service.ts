import type { CapabilityCatalogEntry, ChatTurnCapabilityToolMeshPublicationBinding } from "@goatcitadel/contracts";
import type { MeshChatToolSchema } from "./gateway/mesh-chat-catalog.js";

interface MeshProfileBindingPort {
  resolveMeshToolSchemas?(input: {
    workspaceId: string;
    entries: readonly CapabilityCatalogEntry[];
  }): Promise<MeshChatToolSchema[]>;
  resolveMeshPublicationBinding?(input: {
    workspaceId: string;
    capabilityId: string;
    entrySha256: string;
    manifestSha256: string;
    publisherGeneration: number;
  }): Promise<ChatTurnCapabilityToolMeshPublicationBinding | undefined>;
}

export async function resolveChatMeshProfileToolSchemas(
  deps: MeshProfileBindingPort,
  input: { toolAutonomy: "safe_auto" | "manual"; workspaceId: string },
  callableEntries: CapabilityCatalogEntry[],
): Promise<MeshChatToolSchema[]> {
  const meshTools = input.toolAutonomy !== "manual" && deps.resolveMeshToolSchemas &&
    callableEntries.some((entry) => entry.kind === "mesh_tool" || entry.kind === "mesh_mcp_server")
    ? await deps.resolveMeshToolSchemas({ workspaceId: input.workspaceId, entries: callableEntries }) : [];
  return meshTools;
}

/**
 * HX-408 M2 freeze gate: a mesh-published callable may enter the profile only
 * with a server-verified activation snapshot whose immutable identity matches
 * the exact catalog entry being selected. A missing seam, a failed
 * revalidation, or any identity divergence blocks the turn fail-closed with a
 * content-free reason.
 */
export async function resolveFrozenMeshPublicationBinding(
  deps: MeshProfileBindingPort,
  workspaceId: string,
  canonicalName: string,
  catalogEntry: CapabilityCatalogEntry,
): Promise<ChatTurnCapabilityToolMeshPublicationBinding> {
  const projection = catalogEntry.mesh;
  const blocked = () =>
    new Error(`Mesh-published tool ${canonicalName} is blocked because mesh_capability_freeze_drift.`);
  if (!projection || !deps.resolveMeshPublicationBinding) {
    throw blocked();
  }
  const binding = await deps.resolveMeshPublicationBinding({
    workspaceId,
    capabilityId: catalogEntry.capabilityId,
    entrySha256: projection.entrySha256,
    manifestSha256: projection.manifestSha256,
    publisherGeneration: projection.publisherGeneration,
  });
  if (
    !binding ||
    binding.nodeId !== projection.nodeId ||
    binding.publisherGeneration !== projection.publisherGeneration ||
    binding.manifestSha256 !== projection.manifestSha256 ||
    binding.entrySha256 !== projection.entrySha256 ||
    binding.effectPosture !== projection.effectPosture
  ) {
    throw blocked();
  }
  const copied = structuredClone(binding);
  return Object.freeze(copied);
}

