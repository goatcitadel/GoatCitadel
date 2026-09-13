import { z } from "zod";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { assertMeshCapabilityManifest, type MeshCapabilityManifest } from "./mesh-capability-publication.js";
import {
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityNodeSettlementSubmission,
} from "./mesh-capability-invocation.js";

const identifier = (max = 256) => z.string().min(1).max(max)
  .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = z.number().int().positive().safe();
const timestamp = z.string().datetime({ precision: 3, offset: false })
  .refine((value) => new Date(value).toISOString() === value);
const envelopeSchema = z.object({
  schemaVersion: z.literal(MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION),
  invocationId: identifier(), idempotencyKey: identifier(512), workspaceId: identifier(),
  sessionId: identifier(), turnId: identifier(), runId: identifier().optional(),
  capabilityId: identifier(512), executionProfileSha256: digest, manifestSha256: digest,
  entrySha256: digest, descriptorSha256: digest, permissionEnvelopeSha256: digest,
  activationId: identifier(), activationRevision: generation, nodeId: identifier(128),
  publisherGeneration: generation, publicationLeaseFencingToken: generation,
  inputSha256: digest, deadlineAt: timestamp, approvalId: identifier().optional(),
}).strict();

const failure = { errorCode: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  effectiveCostAttributionSha256: digest.optional() };
const resultSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("succeeded"), output: z.record(z.unknown()),
    effectiveCostAttributionSha256: digest.optional() }).strict(),
  ...(["failed", "cancelled", "timed_out", "unknown"] as const).map((disposition) =>
    z.object({ disposition: z.literal(disposition), ...failure }).strict()),
]);

export type MeshCapabilityNodeExecutionResult = z.infer<typeof resultSchema>;

/** Validates the exact Gateway-authored delivery before a destination uses it. */
export function normalizeMeshCapabilityInvocationEnvelope(value: unknown): MeshCapabilityInvocationDispatchEnvelope {
  return envelopeSchema.parse(value);
}

export function normalizeMeshCapabilityNodeExecutionResult(value: unknown): MeshCapabilityNodeExecutionResult {
  return resultSchema.parse(value);
}

/** Schema validation alone is insufficient: every nested identity must hash to its actual bytes. */
export function assertMeshCapabilityManifestDigests(manifest: MeshCapabilityManifest): void {
  assertMeshCapabilityManifest(manifest);
  const { manifestSha256, ...unsigned } = manifest;
  if (sha256Hex(canonicalJsonString(unsigned)) !== manifestSha256) throw new Error("Mesh manifest digest mismatch.");
  for (const entry of manifest.entries) {
    const { entrySha256, ...unsignedEntry } = entry;
    if (sha256Hex(canonicalJsonString(unsignedEntry)) !== entrySha256 ||
      sha256Hex(canonicalJsonString(entry.descriptor)) !== entry.descriptorSha256 ||
      sha256Hex(canonicalJsonString(entry.descriptor.permissions)) !== entry.permissionEnvelopeSha256)
      throw new Error("Mesh capability entry digest mismatch.");
  }
}

/** The destination retains these exact bytes before the first settlement send. */
export function buildMeshCapabilityNodeSettlement(
  envelope: MeshCapabilityInvocationDispatchEnvelope,
  result: MeshCapabilityNodeExecutionResult,
): MeshCapabilityNodeSettlementSubmission {
  const delivery = normalizeMeshCapabilityInvocationEnvelope(envelope);
  const outcome = normalizeMeshCapabilityNodeExecutionResult(result);
  const evidence = {
    disposition: outcome.disposition,
    ...(outcome.disposition === "succeeded"
      ? { outputSha256: sha256Hex(canonicalJsonString(outcome.output)) }
      : { errorCode: outcome.errorCode }),
    ...(outcome.effectiveCostAttributionSha256 === undefined ? {} : {
      effectiveCostAttributionSha256: outcome.effectiveCostAttributionSha256,
    }),
  };
  return {
    invocationId: delivery.invocationId,
    publisherGeneration: delivery.publisherGeneration,
    publicationLeaseFencingToken: delivery.publicationLeaseFencingToken,
    ...evidence,
    ...(outcome.disposition === "succeeded" ? { output: outcome.output } : {}),
    settlementSha256: sha256Hex(canonicalJsonString({
      schemaVersion: "goatcitadel.mesh-capability-node-settlement.v1",
      envelopeSha256: sha256Hex(canonicalJsonString(delivery)), ...evidence,
    })),
  };
}
