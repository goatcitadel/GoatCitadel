import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  classifyToolEffectPotential,
  deriveMeshCapabilityId,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
} from "@goatcitadel/contracts";
import { createMeshToolPolicyBinding, type MeshToolPolicyBinding } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { MeshCapabilityActivationService } from "../mesh-capability-activation-service.js";

/** Process-local admission evidence, never an invocation or approval credential. */
export interface MeshChatToolSchema {
  readonly canonicalName: string;
  readonly modelName: string;
  readonly providerDefinition: Record<string, unknown>;
  readonly entry: CapabilityCatalogEntry;
  readonly publication: ChatTurnCapabilityToolMeshPublicationBinding;
  readonly policyBinding: MeshToolPolicyBinding;
}

const schemas = new WeakSet<object>();
export const MESH_CHAT_CATALOG_LIMIT = 256;

export function assertMeshChatToolSchema(schema: MeshChatToolSchema): void {
  if (!schemas.has(schema)) throw new Error("Mesh Chat schema is not server-owned");
}

function drift(): never {
  throw new Error("Mesh Chat schema is blocked because mesh_capability_freeze_drift.");
}

/**
 * Load exact schema bytes from the digest-verifying publication repository,
 * then bind them to current activation authority. Catalog annotations alone
 * cannot mint a schema. Published skills remain inspection-only.
 */
export async function resolveMeshChatToolSchemas(
  deps: {
    storage: { meshCapabilityPublications: Pick<AsyncStorage["meshCapabilityPublications"], "getManifest"> };
    activations: Pick<MeshCapabilityActivationService, "resolveProfileBindings">;
  },
  input: { workspaceId: string; entries: readonly CapabilityCatalogEntry[] },
): Promise<MeshChatToolSchema[]> {
  const workspaceId = input.workspaceId;
  const candidates = input.entries.filter((entry) =>
    entry.callable && (entry.kind === "mesh_tool" || entry.kind === "mesh_mcp_server"))
    .map((entry) => structuredClone(entry));
  if (candidates.length === 0) return [];
  const names = new Set<string>();
  for (const entry of candidates) {
    const projection = entry.mesh;
    if (!projection || entry.category !== "mesh_published" || entry.toolName !== undefined ||
      projection.status !== "active" || projection.activation?.revoked ||
      entry.kind !== `mesh_${projection.capabilityKind}` ||
      entry.capabilityId !== deriveMeshCapabilityId(projection.nodeId, projection.capabilityKind, projection.localId) ||
      names.has(entry.capabilityId)) drift();
    names.add(entry.capabilityId);
  }
  // Interleave nodes before applying the shared cap so one publisher cannot
  // consume the complete admission inventory by being listed first.
  const byNode = new Map<string, CapabilityCatalogEntry[]>();
  for (const entry of [...candidates].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))) {
    const group = byNode.get(entry.mesh!.nodeId) ?? [];
    group.push(entry);
    byNode.set(entry.mesh!.nodeId, group);
  }
  const selected: CapabilityCatalogEntry[] = [];
  for (let index = 0; selected.length < Math.min(candidates.length, MESH_CHAT_CATALOG_LIMIT); index += 1) {
    for (const group of byNode.values()) {
      if (group[index] && selected.length < MESH_CHAT_CATALOG_LIMIT) selected.push(group[index]!);
    }
  }
  const manifests = new Map<string, Promise<MeshCapabilityManifest>>();
  const publications = new Map<string, MeshCapabilityManifestEntry>();
  for (let offset = 0; offset < selected.length; offset += 4) {
    await Promise.all(selected.slice(offset, offset + 4).map(async (entry) => {
      const projection = entry.mesh!;
      const key = canonicalJsonString([projection.nodeId, projection.publisherGeneration, projection.manifestSha256]);
      let pending = manifests.get(key);
      if (!pending) {
        pending = (async () => await deps.storage.meshCapabilityPublications.getManifest(workspaceId, projection.nodeId,
          projection.publisherGeneration, projection.manifestSha256))();
        manifests.set(key, pending);
      }
      const manifest = await pending;
      const publication = manifest.entries.find((candidate) => candidate.capabilityId === entry.capabilityId);
      if (manifest.workspaceId !== workspaceId || manifest.nodeId !== projection.nodeId ||
        manifest.admissionGeneration !== projection.admissionGeneration ||
        manifest.publisherGeneration !== projection.publisherGeneration ||
        manifest.manifestSha256 !== projection.manifestSha256 || !publication ||
        publication.localId !== projection.localId || publication.kind !== projection.capabilityKind ||
        publication.entrySha256 !== projection.entrySha256 ||
        publication.descriptor.effectPosture !== projection.effectPosture) drift();
      publications.set(entry.capabilityId, publication);
    }));
  }
  const bindings = await deps.activations.resolveProfileBindings(workspaceId, selected.map((entry) => ({
    capabilityId: entry.capabilityId, entrySha256: entry.mesh!.entrySha256,
    manifestSha256: entry.mesh!.manifestSha256, publisherGeneration: entry.mesh!.publisherGeneration,
  })));
  return selected.map((entry) => {
    const projection = entry.mesh!;
    const publication = publications.get(entry.capabilityId)!;
    const binding = bindings.get(entry.capabilityId);
    if (!binding || binding.nodeId !== projection.nodeId ||
      binding.publisherGeneration !== projection.publisherGeneration ||
      binding.manifestSha256 !== projection.manifestSha256 || binding.entrySha256 !== projection.entrySha256 ||
      binding.effectPosture !== projection.effectPosture ||
      binding.permissionEnvelopeSha256 !== publication.permissionEnvelopeSha256 ||
      (projection.activation && (projection.activation.activationId !== binding.activationId ||
        projection.activation.activationRevision !== binding.activationRevision))) drift();
    const descriptor = publication.descriptor;
    if (descriptor.kind === "skill") drift();
    const modelName = `mesh_${createHash("sha256").update(canonicalJsonString({
      capabilityId: entry.capabilityId, descriptorSha256: publication.descriptorSha256, binding,
    })).digest("hex").slice(0, 56)}`;
    // A published MCP server advertises tool names and schema digests, not
    // native schema bytes. Expose the server's explicit selector envelope;
    // never fabricate a native tool schema from its digest.
    const parameters = descriptor.kind === "tool" ? descriptor.inputSchema : {
      type: "object",
      properties: {
        toolName: { type: "string", enum: descriptor.tools.map((tool) => tool.name) },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["toolName", "arguments"],
      additionalProperties: false,
    };
    const schema: MeshChatToolSchema = Object.freeze({
      canonicalName: entry.capabilityId, modelName,
      entry: freezeJson({ ...structuredClone(entry), effectPotential: classifyToolEffectPotential({
        toolName: entry.capabilityId, trustedBuiltin: false, sourceKind: "remote",
      }) }),
      publication: freezeJson(structuredClone(binding)),
      providerDefinition: freezeJson({ type: "function", function: {
        name: modelName, description: descriptor.description ?? descriptor.title,
        parameters: structuredClone(parameters),
      } }),
      policyBinding: createMeshToolPolicyBinding({ canonicalName: entry.capabilityId,
        nodeId: projection.nodeId, kind: descriptor.kind, localId: publication.localId }),
    });
    schemas.add(schema);
    return schema;
  });
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}
