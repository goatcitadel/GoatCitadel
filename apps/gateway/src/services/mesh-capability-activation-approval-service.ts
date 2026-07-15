import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  assertMeshCapabilityEffectDiff,
  assertMeshCapabilityPermissionDiff,
  canonicalJsonString,
  type ApprovalRequest,
  type MeshCapabilityEffectDiff,
  type MeshCapabilityPermissionDiff,
} from "@goatcitadel/contracts";
import { buildMeshCapabilityActivationApprovalPayload, type ActivateMeshCapabilityInput } from "@goatcitadel/storage";
import {
  commitMeshCapabilityActivationApproval,
  type MeshCapabilityActivationApprovalLifecycleHost,
} from "./approval-lifecycle-service.js";

const MESH_CAPABILITY_ACTIVATION_APPROVAL_ID_SCHEMA_VERSION =
  "goatcitadel.mesh-capability-activation-approval-id.v1" as const;

const REQUIRED_INPUT_KEYS = [
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
  "effectPosture",
  "permissionDiff",
  "effectDiff",
  "actorId",
  "idempotencyKey",
] as const;

const OPTIONAL_INPUT_KEYS = ["sessionId", "turnId"] as const;

export type CreateMeshCapabilityActivationApprovalInput = Omit<ActivateMeshCapabilityInput, "approvalId">;

export interface CreateMeshCapabilityActivationApprovalResult {
  approval: ApprovalRequest;
  activationInput: ActivateMeshCapabilityInput;
  replayed: boolean;
}

export type MeshCapabilityActivationApprovalServiceHost = MeshCapabilityActivationApprovalLifecycleHost;

export function createMeshCapabilityActivationApproval(
  host: MeshCapabilityActivationApprovalServiceHost,
  input: CreateMeshCapabilityActivationApprovalInput,
): CreateMeshCapabilityActivationApprovalResult {
  assertExactActivationApprovalInput(input);
  // Validate the caller's original nested records before cloning. Cloning
  // first would silently discard unknown keys and turn malformed input into a
  // different, apparently valid approval request.
  assertMeshCapabilityPermissionDiff(input.permissionDiff, input.permissionEnvelopeSha256);
  assertMeshCapabilityEffectDiff(input.effectDiff, input.effectPosture);
  const approvalId = deriveMeshCapabilityActivationApprovalId(input);
  const activationInput = freezeActivationInput({
    workspaceId: input.workspaceId,
    activationId: input.activationId,
    activationRevision: input.activationRevision,
    capabilityId: input.capabilityId,
    nodeId: input.nodeId,
    publisherGeneration: input.publisherGeneration,
    healthGeneration: input.healthGeneration,
    publicationLeaseFencingToken: input.publicationLeaseFencingToken,
    manifestSha256: input.manifestSha256,
    entrySha256: input.entrySha256,
    descriptorSha256: input.descriptorSha256,
    permissionEnvelopeSha256: input.permissionEnvelopeSha256,
    effectPosture: input.effectPosture,
    permissionDiff: clonePermissionDiff(input.permissionDiff),
    effectDiff: cloneEffectDiff(input.effectDiff),
    approvalId,
    actorId: input.actorId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    idempotencyKey: input.idempotencyKey,
  });
  const payload = buildMeshCapabilityActivationApprovalPayload(activationInput);
  const committed = commitMeshCapabilityActivationApproval(host, {
    approvalId,
    payload,
    preview: {
      activationId: payload.activationId,
      activationRevision: payload.activationRevision,
      capabilityId: payload.capabilityId,
      effectPosture: payload.effectPosture,
    },
    linkage: {
      workspaceId: payload.workspaceId,
      ...(activationInput.sessionId === undefined ? {} : { sessionId: activationInput.sessionId }),
      ...(activationInput.turnId === undefined ? {} : { turnId: activationInput.turnId }),
    },
  });

  return {
    approval: committed.approval,
    activationInput,
    replayed: committed.replayed,
  };
}

function deriveMeshCapabilityActivationApprovalId(
  input: Pick<ActivateMeshCapabilityInput, "workspaceId" | "activationId" | "activationRevision">,
): string {
  assertCanonicalIdentifier(input.workspaceId, "workspaceId", 256);
  assertCanonicalIdentifier(input.activationId, "activationId", 256);
  assertPositiveSafeInteger(input.activationRevision, "activationRevision");
  const digest = createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: MESH_CAPABILITY_ACTIVATION_APPROVAL_ID_SCHEMA_VERSION,
        workspaceId: input.workspaceId,
        activationId: input.activationId,
        activationRevision: input.activationRevision,
      }),
      "utf8",
    )
    .digest("hex");
  return `mesh-capability-activation:${digest}`;
}

function clonePermissionDiff(input: MeshCapabilityPermissionDiff): MeshCapabilityPermissionDiff {
  return {
    schemaVersion: input.schemaVersion,
    disposition: input.disposition,
    ...(input.priorActivationId === undefined ? {} : { priorActivationId: input.priorActivationId }),
    ...(input.priorPermissionEnvelopeSha256 === undefined
      ? {}
      : { priorPermissionEnvelopeSha256: input.priorPermissionEnvelopeSha256 }),
    currentPermissionEnvelopeSha256: input.currentPermissionEnvelopeSha256,
    added: [...input.added],
    removed: [...input.removed],
  };
}

function cloneEffectDiff(input: MeshCapabilityEffectDiff): MeshCapabilityEffectDiff {
  return {
    schemaVersion: input.schemaVersion,
    disposition: input.disposition,
    ...(input.priorActivationId === undefined ? {} : { priorActivationId: input.priorActivationId }),
    ...(input.priorEffectPosture === undefined ? {} : { priorEffectPosture: input.priorEffectPosture }),
    currentEffectPosture: input.currentEffectPosture,
  };
}

function freezeActivationInput(input: ActivateMeshCapabilityInput): ActivateMeshCapabilityInput {
  Object.freeze(input.permissionDiff.added);
  Object.freeze(input.permissionDiff.removed);
  Object.freeze(input.permissionDiff);
  Object.freeze(input.effectDiff);
  return Object.freeze(input);
}

function assertExactActivationApprovalInput(
  input: CreateMeshCapabilityActivationApprovalInput,
): asserts input is CreateMeshCapabilityActivationApprovalInput {
  assertSafeJsonRecord(input, "activation approval input");
  const actualKeys = Object.getOwnPropertyNames(input).sort();
  const expectedKeys = [
    ...REQUIRED_INPUT_KEYS,
    ...OPTIONAL_INPUT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key)),
  ].sort();
  if (canonicalJsonString(actualKeys) !== canonicalJsonString(expectedKeys)) {
    throw new TypeError("Mesh capability activation approval input has an invalid key set.");
  }
}

function assertCanonicalIdentifier(value: unknown, field: string, max: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Mesh capability ${field} is not a canonical identifier.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Mesh capability ${field} must be a positive safe integer.`);
  }
}

function assertSafeJsonRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`Mesh capability ${field} must be a plain record.`);
  }
  assertSafeJsonValue(value, field, new Set<object>());
}

function assertSafeJsonValue(value: unknown, field: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`Mesh capability ${field} contains a non-JSON number.`);
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new TypeError(`Mesh capability ${field} contains an unsafe value.`);
  }
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) || seen.has(value)) {
    throw new TypeError(`Mesh capability ${field} contains an unsafe object.`);
  }
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Mesh capability ${field} contains symbol keys.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (isArray) {
      const length = descriptors.length?.value;
      const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        elementKeys.length !== length ||
        elementKeys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError(`Mesh capability ${field} contains a sparse or extended array.`);
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Mesh capability ${field} contains an accessor.`);
      }
      assertSafeJsonValue(descriptor.value, field, seen);
    }
  } finally {
    seen.delete(value);
  }
}
