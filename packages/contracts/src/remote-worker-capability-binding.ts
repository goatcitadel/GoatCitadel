import { canonicalJsonString } from "./canonical-json.js";
import { mcpRequesterAdmissionScopeSchema, type McpRequesterAdmissionScope } from "./chat-feature-references.js";
import type { DurableChatTurnExecutionPayloadAuthority } from "./durable-chat-turn-payload.js";

/** Exact immutable evidence for profile-free Chat. It does not grant a worker
 * permission, prove a current lease, or replace the selected feature owners. */
export interface RemoteWorkerAdmissionReference {
  readonly version: "goatcitadel.remote-worker-admission-reference.v1";
  readonly scope: McpRequesterAdmissionScope;
  readonly featureReferenceSha256: string;
}

/** Historical records retain their original JSON and hashes. New assignments
 * carry admissionReference and omit capabilityProfileSha256 entirely. */
export interface RemoteWorkerCapabilityBinding {
  readonly capabilityProfileSha256?: string;
  readonly admissionReference?: RemoteWorkerAdmissionReference;
}

export function normalizeRemoteWorkerCapabilityBinding(
  input: RemoteWorkerCapabilityBinding,
): RemoteWorkerCapabilityBinding {
  if ((input.capabilityProfileSha256 === undefined) === (input.admissionReference === undefined))
    throw new TypeError("Remote worker requires exactly one capability authority variant.");
  if (input.capabilityProfileSha256 !== undefined) {
    assertDigest(input.capabilityProfileSha256);
    return Object.freeze({ capabilityProfileSha256: input.capabilityProfileSha256 });
  }
  const reference = input.admissionReference!;
  if (
    !reference ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(reference)) ||
    Object.keys(reference).some((key) => !["version", "scope", "featureReferenceSha256"].includes(key)) ||
    reference.version !== "goatcitadel.remote-worker-admission-reference.v1"
  )
    throw new TypeError("Unsupported remote worker admission reference.");
  assertDigest(reference.featureReferenceSha256);
  const scope = Object.freeze(mcpRequesterAdmissionScopeSchema.parse(reference.scope));
  return Object.freeze({
    admissionReference: Object.freeze({
      version: reference.version,
      scope,
      featureReferenceSha256: reference.featureReferenceSha256,
    }),
  });
}

export function sameRemoteWorkerCapabilityBinding(
  left: RemoteWorkerCapabilityBinding,
  right: RemoteWorkerCapabilityBinding,
): boolean {
  return (
    canonicalJsonString(normalizeRemoteWorkerCapabilityBinding(left)) ===
    canonicalJsonString(normalizeRemoteWorkerCapabilityBinding(right))
  );
}

export function remoteWorkerCapabilityBindingForTurn(
  authority: DurableChatTurnExecutionPayloadAuthority,
): RemoteWorkerCapabilityBinding {
  if (authority.capabilityProfileId && authority.capabilityProfileHash)
    return normalizeRemoteWorkerCapabilityBinding({ capabilityProfileSha256: authority.capabilityProfileHash });
  if (authority.capabilityProfileId || authority.capabilityProfileHash || !authority.featureReferenceSha256)
    throw new TypeError("Remote worker turn has no complete capability authority.");
  return normalizeRemoteWorkerCapabilityBinding({
    admissionReference: {
      version: "goatcitadel.remote-worker-admission-reference.v1",
      featureReferenceSha256: authority.featureReferenceSha256,
      scope: mcpRequesterAdmissionScopeSchema.parse({
        admissionId: authority.admissionId,
        sessionIncarnationId: authority.sessionIncarnationId,
        workspaceId: authority.workspaceId,
        sessionId: authority.sessionId,
        turnId: authority.turnId,
        aggregateRevision: authority.admissionAggregateRevision,
        controllerGeneration: authority.admissionControllerGeneration,
        materialSha256: authority.admissionMaterialSha256,
        actorId: authority.requestActor.authActorId,
        actorSource: authority.requestActor.authActorSource,
      }),
    },
  });
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError("Remote worker capability authority digest is invalid.");
}
