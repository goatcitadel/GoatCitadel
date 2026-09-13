import type { MeshCapabilityInvocationIntentRecord, MeshCapabilitySettlementDisposition } from "./mesh-capability-publication.js";

export const MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION =
  "goatcitadel.mesh-capability-invocation-envelope.v1" as const;
export const MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE = "mesh_capability_invocation_dispatch" as const;
export const MESH_CAPABILITY_MAX_PENDING_INVOCATIONS = 256;

export interface MeshCapabilityNodeSettlementSubmission {
  invocationId: string;
  disposition: MeshCapabilitySettlementDisposition;
  settlementSha256: string;
  outputSha256?: string;
  /** Required for a successful node settlement; schema-checked transient bytes, with only their digest durable. */
  output?: Record<string, unknown>;
  errorCode?: string;
  effectiveCostAttributionSha256?: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
}

export interface MeshCapabilityNodeProgressSubmission {
  invocationId: string;
  sequence: number;
  stage: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
}

/** Gateway-authored delivery identity. Arguments and credentials are absent. */
export interface MeshCapabilityInvocationDispatchEnvelope {
  schemaVersion: typeof MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION;
  invocationId: string;
  idempotencyKey: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  capabilityId: string;
  executionProfileSha256: string;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  activationId: string;
  activationRevision: number;
  nodeId: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
  inputSha256: string;
  deadlineAt: string;
  approvalId?: string;
}

/** At most MESH_CAPABILITY_MAX_PENDING_INVOCATIONS, scoped by node admission. */
export interface MeshCapabilityInvocationPendingList {
  items: MeshCapabilityInvocationDispatchEnvelope[];
}

/** Transient arguments, available only while the exact dispatch remains callable. */
export interface MeshCapabilityInvocationInputResponse {
  invocationId: string;
  inputSha256: string;
  input: Record<string, unknown>;
}

/** Exact public projection; callers cannot add authority by supplying extra fields. */
export function buildMeshCapabilityDispatchEnvelope(
  intent: MeshCapabilityInvocationIntentRecord,
): MeshCapabilityInvocationDispatchEnvelope {
  return {
    schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
    invocationId: intent.invocationId,
    idempotencyKey: intent.idempotencyKey,
    workspaceId: intent.workspaceId,
    sessionId: intent.sessionId,
    turnId: intent.turnId,
    ...(intent.runId === undefined ? {} : { runId: intent.runId }),
    capabilityId: intent.capabilityId,
    executionProfileSha256: intent.executionProfileSha256,
    manifestSha256: intent.manifestSha256,
    entrySha256: intent.entrySha256,
    descriptorSha256: intent.descriptorSha256,
    permissionEnvelopeSha256: intent.permissionEnvelopeSha256,
    activationId: intent.activationId,
    activationRevision: intent.activationRevision,
    nodeId: intent.nodeId,
    publisherGeneration: intent.publisherGeneration,
    publicationLeaseFencingToken: intent.publicationLeaseFencingToken,
    inputSha256: intent.inputSha256,
    deadlineAt: intent.deadlineAt,
    ...(intent.approvalId === undefined ? {} : { approvalId: intent.approvalId }),
  };
}
