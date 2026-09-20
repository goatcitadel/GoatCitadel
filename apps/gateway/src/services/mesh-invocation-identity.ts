import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityInvocationIntentRecord,
} from "@goatcitadel/contracts";

export function activationMatchesIntent(
  activation: MeshCapabilityActivationRecord,
  intent: MeshCapabilityInvocationIntentRecord,
): boolean {
  return (
    [
      "workspaceId",
      "activationId",
      "activationRevision",
      "capabilityId",
      "nodeId",
      "publisherGeneration",
      "healthGeneration",
      "publicationLeaseFencingToken",
      "manifestSha256",
      "entrySha256",
      "descriptorSha256",
      "permissionEnvelopeSha256",
    ] as const
  ).every((key) => activation[key] === intent[key]);
}

export function deriveMeshCapabilityInvocationId(input: {
  workspaceId: string;
  toolRunId: string;
  capabilityId: string;
  binding: Pick<
    ChatTurnCapabilityToolMeshPublicationBinding,
    "activationId" | "activationRevision" | "publisherGeneration" | "publicationLeaseFencingToken"
  >;
  inputSha256: string;
}): string {
  const material = canonicalJsonString({
    schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    toolRunId: input.toolRunId,
    capabilityId: input.capabilityId,
    activationId: input.binding.activationId,
    activationRevision: input.binding.activationRevision,
    publisherGeneration: input.binding.publisherGeneration,
    publicationLeaseFencingToken: input.binding.publicationLeaseFencingToken,
    inputSha256: input.inputSha256,
  });
  return `mesh-invocation-${sha256Utf8(material).slice(0, 48)}`;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
