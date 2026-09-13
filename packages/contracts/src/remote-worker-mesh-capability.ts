import { z } from "zod";
import { MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST } from "./mesh-capability-publication.js";
import type { MeshCapabilityManifestPublishReceipt, MeshCapabilityOwnPublicationList, MeshCapabilityInvocationSettlementRecord } from "./mesh-capability-publication.js";
import type { MeshCapabilityInvocationPendingList, MeshCapabilityInvocationInputResponse } from "./mesh-capability-invocation.js";

export const REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION = "goatcitadel.remote-worker-mesh-capability.v1" as const;
export const REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH = "/api/v1/remote-workers/mesh-capability-exchanges" as const;
export const REMOTE_WORKER_MESH_CAPABILITY_OPERATION = "mesh.capability.exchange" as const;

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = z.number().int().positive().safe();
const base = { schemaVersion: z.literal(REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION), workspaceId: identifier };
const submissionBinding = { invocationId: identifier, publisherGeneration: generation, publicationLeaseFencingToken: generation };

function canonicalPublicationKey(value: string): boolean {
  return value === value.normalize("NFKC").trim() &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

/** Closed action bodies; neither node identity nor arbitrary HTTP targets are accepted. */
export const remoteWorkerMeshCapabilityPayloadSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("publish"), submission: z.object({
    publicationKey: z.string().min(1).max(512).refine(canonicalPublicationKey),
    supersedesManifestSha256: digest.optional(),
    entries: z.array(z.object({
      localId: z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u),
      kind: z.enum(["tool", "mcp_server", "skill"]), descriptor: z.record(z.unknown()), descriptorSha256: digest,
    }).strict()).min(1).max(MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST),
  }).strict() }).strict(),
  z.object({ ...base, action: z.literal("publications") }).strict(),
  z.object({ ...base, action: z.literal("pending") }).strict(),
  z.object({ ...base, action: z.literal("input"), invocationId: identifier }).strict(),
  z.object({ ...base, action: z.literal("progress"), submission: z.object({
    ...submissionBinding, sequence: z.number().int().min(1).max(1_000_000),
    stage: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  }).strict() }).strict(),
  z.object({ ...base, action: z.literal("settle"), submission: z.object({
    ...submissionBinding, disposition: z.enum(["succeeded", "failed", "cancelled", "timed_out", "unknown"]),
    settlementSha256: digest, outputSha256: digest.optional(), output: z.record(z.unknown()).optional(),
    errorCode: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u).optional(),
    effectiveCostAttributionSha256: digest.optional(),
  }).strict() }).strict(),
]);

export type RemoteWorkerMeshCapabilityPayload = z.infer<typeof remoteWorkerMeshCapabilityPayloadSchema>;
export interface RemoteWorkerMeshCapabilityResults {
  publish: MeshCapabilityManifestPublishReceipt;
  publications: MeshCapabilityOwnPublicationList;
  pending: MeshCapabilityInvocationPendingList;
  input: MeshCapabilityInvocationInputResponse;
  progress: { accepted: true; sequence: number };
  settle: { settlement: MeshCapabilityInvocationSettlementRecord; replayed: boolean };
}
export type RemoteWorkerMeshCapabilityResponse = {
  [Action in keyof RemoteWorkerMeshCapabilityResults]: {
    schemaVersion: typeof REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION;
    operation: typeof REMOTE_WORKER_MESH_CAPABILITY_OPERATION;
    action: Action;
    workspaceId: string;
    nodeId: string;
    result: RemoteWorkerMeshCapabilityResults[Action];
  }
}[keyof RemoteWorkerMeshCapabilityResults];
