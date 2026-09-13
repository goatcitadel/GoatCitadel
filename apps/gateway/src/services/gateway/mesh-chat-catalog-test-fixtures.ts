import {
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  deriveMeshCapabilityId,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type MeshCapabilityDescriptor,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
} from "@goatcitadel/contracts";
import {
  computeMeshCapabilityDescriptorSha256,
  computeMeshCapabilityEntrySha256,
  computeMeshCapabilityManifestSha256,
} from "@goatcitadel/storage";
import { resolveMeshChatToolSchemas } from "./mesh-chat-catalog.js";

/** Synthetic immutable bytes for owner-boundary tests; no live node or execution authority. */
export function createMeshChatCatalogFixture(options: {
  workspaceId?: string; nodeId?: string; localId?: string; kind?: "tool" | "mcp_server";
} = {}) {
  const workspaceId = options.workspaceId ?? "workspace-1";
  const nodeId = options.nodeId ?? "node-a";
  const localId = options.localId ?? "project.status";
  const kind = options.kind ?? "tool";
  const capabilityId = deriveMeshCapabilityId(nodeId, kind, localId);
  const base = {
    title: "Project status", semanticVersion: "1.0.0", effectPosture: "read_only" as const,
    permissions: { schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION, filesystemRead: ["workspace://project"],
      filesystemWrite: [], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 4_096 },
    healthCheck: { protocol: "mesh.capability-health.v1" as const, intervalMs: 30_000, timeoutMs: 5_000 },
  };
  const descriptor: MeshCapabilityDescriptor = kind === "tool" ? {
    ...base, kind, inputSchema: { type: "object", properties: { query: { type: "string" } },
      required: ["query"], additionalProperties: false }, outputSchema: { type: "object" }, idempotency: "none",
  } : {
    ...base, kind, protocol: "mcp", protocolVersion: "2025-03-26",
    tools: [{ name: "project.status", inputSchemaSha256: "1".repeat(64) },
      { name: "project.search", inputSchemaSha256: "2".repeat(64) }],
  };
  const unsignedEntry = { capabilityId, localId, kind, descriptor,
    descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
    permissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(descriptor.permissions) };
  const publication: MeshCapabilityManifestEntry = {
    ...unsignedEntry, entrySha256: computeMeshCapabilityEntrySha256(unsignedEntry),
  };
  const unsignedManifest = {
    schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId, nodeId, admissionGeneration: 1,
    publisherGeneration: 3, publicationKey: "schema-fixture", publicationLeaseFencingToken: 5,
    entries: [publication], createdAt: "2026-09-11T00:00:00.000Z",
  };
  const manifest: MeshCapabilityManifest = {
    ...unsignedManifest, manifestSha256: computeMeshCapabilityManifestSha256(unsignedManifest),
  };
  const binding: ChatTurnCapabilityToolMeshPublicationBinding = {
    nodeId, publisherGeneration: 3, manifestSha256: manifest.manifestSha256, entrySha256: publication.entrySha256,
    activationId: `mesh-activation-${"f".repeat(48)}`, activationRevision: 2, publicationLeaseFencingToken: 5,
    permissionEnvelopeSha256: publication.permissionEnvelopeSha256, effectPosture: "read_only", healthGeneration: 4,
  };
  const entry: CapabilityCatalogEntry = {
    capabilityId, kind: kind === "tool" ? "mesh_tool" : "mesh_mcp_server", category: "mesh_published",
    title: descriptor.title, summary: "Published project operations.", callable: true, trustLabel: "Mesh activated",
    mesh: { nodeId, admissionGeneration: 1, publisherGeneration: 3, manifestSha256: manifest.manifestSha256,
      entrySha256: publication.entrySha256, localId, capabilityKind: kind, status: "active",
      reasons: ["activation_live"], effectPosture: "read_only" },
  };
  const deps: Parameters<typeof resolveMeshChatToolSchemas>[0] = {
    storage: { meshCapabilityPublications: { getManifest: async () => structuredClone(manifest) } },
    activations: { resolveProfileBindings: async () => new Map([[capabilityId, structuredClone(binding)]]) },
  };
  return { workspaceId, capabilityId, manifest, publication, binding, entry, deps };
}
