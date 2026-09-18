import { NotFoundError, canonicalJsonString, buildMeshCapabilityDispatchEnvelope as buildDispatchEnvelope, type MeshCapabilityInvocationIntentRecord, type MeshCapabilityInvocationDispatchEnvelope } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { MeshCapabilityAuthenticatedNodeIdentity } from "./mesh-capability-publication-service.js";
import { MeshCapabilityInvocationServiceError } from "./mesh-capability-invocation-errors.js";

type MeshInvocationReadStorage = Pick<Storage, "meshCapabilityPublications">;

export interface InputVaultEntry {
  inputCanonicalJson: string;
  inputSha256: string;
  dispatchStarted: boolean;
  /** Present only after the replication owner confirms the exact envelope. */
  dispatchEnvelope?: Readonly<MeshCapabilityInvocationDispatchEnvelope>;
  expiresAtMs: number;
  outputSha256?: string;
  output?: Record<string, unknown>;
}

export async function requireMeshInvocationIntentForNode(
  storage: MeshInvocationReadStorage,
  identity: MeshCapabilityAuthenticatedNodeIdentity,
  invocationId: string,
): Promise<MeshCapabilityInvocationIntentRecord> {
  if (typeof invocationId !== "string" || invocationId.length < 1 || invocationId.length > 256) {
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
  }
  const intent = await storage.meshCapabilityPublications.findInvocationIntent(
    identity.workspaceId,
    invocationId,
  );
  if (!intent) {
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
  }
  if (intent.nodeId !== identity.nodeId) {
    // Admission-bound identity, never body-claimed: only the dispatched
    // node can read input, report progress, or settle this invocation.
    throw new MeshCapabilityInvocationServiceError("mesh_capability_settlement_node_mismatch");
  }
  return intent;
}

export async function prepareMeshInvocationInputRead(
  storage: MeshInvocationReadStorage,
  readVaultEntry: (workspaceId: string, invocationId: string) => InputVaultEntry | undefined,
  now: () => Date,
  identity: MeshCapabilityAuthenticatedNodeIdentity,
  invocationId: string,
): Promise<{ intent: MeshCapabilityInvocationIntentRecord; entry: InputVaultEntry }> {
  const intent = await requireMeshInvocationIntentForNode(storage, identity, invocationId);
  const entry = readVaultEntry(identity.workspaceId, invocationId);
  if (!entry?.dispatchStarted || !entry.dispatchEnvelope || entry.inputSha256 !== intent.inputSha256 ||
    canonicalJsonString(entry.dispatchEnvelope) !== canonicalJsonString(buildDispatchEnvelope(intent)))
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
  let publisher;
  try {
    publisher = await storage.meshCapabilityPublications.getPublisher(
      identity.workspaceId, identity.nodeId, intent.publisherGeneration,
    );
  } catch (error) {
    if (error instanceof NotFoundError)
      throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
    throw error;
  }
  if (publisher.admissionGeneration !== identity.admissionGeneration ||
    publisher.mtlsRequired !== identity.mtlsRequired || publisher.tlsFingerprint !== identity.tlsFingerprint)
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable");
  const settled = await storage.meshCapabilityPublications.findInvocationSettlement(identity.workspaceId, invocationId);
  if (settled || Date.parse(intent.deadlineAt) <= now().getTime())
    throw new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found");
  return { intent, entry };
}

