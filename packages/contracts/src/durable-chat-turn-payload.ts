import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

export interface DurableChatTurnRequestActorAuthority {
  readonly actorKind: "operator" | "external_companion" | "system";
  readonly actorId: string;
  readonly operatorId?: string;
  readonly authActorId?: string;
  readonly authActorSource?: string;
}

export interface DurableChatTurnSurfaceDerivationAuthority {
  readonly version: 1;
  readonly originalMode: string | null;
  readonly originalAutoRoute: boolean | null;
  readonly effectiveMode: "chat";
  readonly effectiveAutoRoute: false;
}

/**
 * Shared structural and cryptographic authority for a durable Chat v2 payload.
 * Storage and Gateway must use this reader before treating payload bytes as an
 * executable Chat turn. Database-current admission and lease checks remain the
 * responsibility of their storage owner.
 */
export interface DurableChatTurnExecutionPayloadAuthority extends Readonly<Record<string, unknown>> {
  readonly version: "chat.turn.execute.v2";
  readonly admissionId: string;
  readonly sessionIncarnationId: string;
  readonly admissionMaterialSha256: string;
  readonly workspaceId: string;
  readonly admissionAggregateRevision: number;
  readonly admissionControllerGeneration: number;
  readonly effectiveRequestMaterialSha256: string;
  readonly policyRunIdDerivation?: Readonly<{
    version: 1;
    kind: "durable_run_id";
    runId: string;
  }>;
  readonly surfaceDerivation?: DurableChatTurnSurfaceDerivationAuthority;
  readonly requestActor: DurableChatTurnRequestActorAuthority;
  readonly sessionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly capabilityProfileId?: string;
  readonly capabilityProfileHash?: string;
  readonly routedContextSnapshotId?: string;
  readonly routedContextSnapshotHash?: string;
  readonly branchKind: string;
  readonly threadEventType: string;
  readonly request: Readonly<Record<string, unknown>>;
}

export interface ReadDurableChatTurnExecutionPayloadAuthorityInput {
  readonly workflowKey: unknown;
  readonly durableRunId: unknown;
  readonly payload: unknown;
}

export function readDurableChatTurnExecutionPayloadAuthority(
  input: ReadDurableChatTurnExecutionPayloadAuthorityInput,
): DurableChatTurnExecutionPayloadAuthority | undefined {
  try {
    if (input.workflowKey !== "chat.turn.execute" || !nonEmptyString(input.durableRunId)) return undefined;
    const payload = record(input.payload);
    if (!payload || payload.version !== "chat.turn.execute.v2") return undefined;
    if (
      !nonEmptyString(payload.admissionId) ||
      !nonEmptyString(payload.sessionIncarnationId) ||
      !sha256(payload.admissionMaterialSha256) ||
      !nonEmptyString(payload.workspaceId) ||
      !positiveInteger(payload.admissionAggregateRevision) ||
      !positiveInteger(payload.admissionControllerGeneration) ||
      !sha256(payload.effectiveRequestMaterialSha256) ||
      !nonEmptyString(payload.sessionId) ||
      !nonEmptyString(payload.turnId) ||
      !nonEmptyString(payload.userMessageId) ||
      !nonEmptyString(payload.assistantMessageId) ||
      typeof payload.branchKind !== "string" ||
      typeof payload.threadEventType !== "string"
    ) {
      return undefined;
    }
    const request = record(payload.request);
    if (!request || ["signal", "operatorId", "authActorId", "authActorSource"].some((key) => key in request)) {
      return undefined;
    }
    if (!readRequestActor(payload.requestActor) || !readSurfaceDerivation(payload.surfaceDerivation)) return undefined;
    if (!hasExactPolicyRunIdDerivation(input.durableRunId, request, payload.policyRunIdDerivation)) return undefined;
    const admittedRequest = reconstructAdmittedRequest(request, payload.surfaceDerivation);
    if (!admittedRequest) return undefined;
    if (
      sha256Hex(canonicalJsonString({ version: 2, request: admittedRequest })) !== payload.admissionMaterialSha256 ||
      sha256Hex(
        canonicalJsonString({
          version: 1,
          admissionMaterialSha256: payload.admissionMaterialSha256,
          request,
        }),
      ) !== payload.effectiveRequestMaterialSha256
    ) {
      return undefined;
    }
    if (
      (payload.capabilityProfileId !== undefined && typeof payload.capabilityProfileId !== "string") ||
      (payload.capabilityProfileHash !== undefined && typeof payload.capabilityProfileHash !== "string") ||
      Boolean(payload.capabilityProfileId) !== Boolean(payload.capabilityProfileHash) ||
      containsRawRoutedContext(payload) ||
      (payload.routedContextSnapshotId !== undefined &&
        (!nonEmptyString(payload.routedContextSnapshotId) || payload.routedContextSnapshotId.length > 256)) ||
      (payload.routedContextSnapshotHash !== undefined && !sha256(payload.routedContextSnapshotHash)) ||
      Boolean(payload.routedContextSnapshotId) !== Boolean(payload.routedContextSnapshotHash) ||
      (Boolean(payload.routedContextSnapshotId) && !payload.capabilityProfileId)
    ) {
      return undefined;
    }
    return payload as DurableChatTurnExecutionPayloadAuthority;
  } catch {
    return undefined;
  }
}

function reconstructAdmittedRequest(
  effectiveRequest: Readonly<Record<string, unknown>>,
  surfaceDerivation: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const derivation = surfaceDerivation as DurableChatTurnSurfaceDerivationAuthority | undefined;
  if (!derivation) return freezeRequest(effectiveRequest);
  if (effectiveRequest.mode !== "chat" || effectiveRequest.autoRoute !== false) return undefined;
  const admitted: Record<string, unknown> = { ...effectiveRequest };
  if (derivation.originalMode === null) delete admitted.mode;
  else admitted.mode = derivation.originalMode;
  if (derivation.originalAutoRoute === null) delete admitted.autoRoute;
  else admitted.autoRoute = derivation.originalAutoRoute;
  return freezeRequest(admitted);
}

function freezeRequest(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  if (typeof request.content !== "string") return undefined;
  const {
    signal: _signal,
    operatorId: _operatorId,
    authActorId: _authActorId,
    authActorSource: _authActorSource,
    contextRefs: _contextRefs,
    ...serializable
  } = request;
  return JSON.parse(canonicalJsonString({ ...serializable, content: request.content.trim() })) as Readonly<
    Record<string, unknown>
  >;
}

function readRequestActor(value: unknown): value is DurableChatTurnRequestActorAuthority {
  const actor = record(value);
  if (!actor) return false;
  const allowed = new Set(["actorKind", "actorId", "operatorId", "authActorId", "authActorSource"]);
  if (Object.keys(actor).some((key) => !allowed.has(key))) return false;
  const hasKind =
    actor.actorKind === "operator" || actor.actorKind === "external_companion" || actor.actorKind === "system";
  const hasOperatorProjection =
    actor.operatorId !== undefined || actor.authActorId !== undefined || actor.authActorSource !== undefined;
  return Boolean(
    hasKind &&
    nonEmptyString(actor.actorId) &&
    (actor.actorKind === "operator" || !hasOperatorProjection) &&
    (actor.operatorId === undefined || typeof actor.operatorId === "string") &&
    (actor.authActorId === undefined || typeof actor.authActorId === "string") &&
    (actor.authActorSource === undefined || typeof actor.authActorSource === "string"),
  );
}

function readSurfaceDerivation(value: unknown): value is DurableChatTurnSurfaceDerivationAuthority | undefined {
  if (value === undefined) return true;
  const derivation = record(value);
  if (!derivation) return false;
  if (
    Object.keys(derivation).sort().join("|") !==
    ["effectiveAutoRoute", "effectiveMode", "originalAutoRoute", "originalMode", "version"].sort().join("|")
  ) {
    return false;
  }
  return (
    derivation.version === 1 &&
    derivation.effectiveMode === "chat" &&
    derivation.effectiveAutoRoute === false &&
    (derivation.originalMode === null || typeof derivation.originalMode === "string") &&
    (derivation.originalAutoRoute === null || typeof derivation.originalAutoRoute === "boolean")
  );
}

function hasExactPolicyRunIdDerivation(
  durableRunId: unknown,
  request: Record<string, unknown>,
  value: unknown,
): boolean {
  const policyRunId = typeof request.policyRunId === "string" ? request.policyRunId.trim() : undefined;
  if (request.policyRunId !== undefined && !policyRunId) return false;
  if (policyRunId) return value === undefined;
  const derivation = record(value);
  return Boolean(
    derivation &&
    Object.keys(derivation).sort().join(",") === "kind,runId,version" &&
    derivation.version === 1 &&
    derivation.kind === "durable_run_id" &&
    derivation.runId === durableRunId,
  );
}

function containsRawRoutedContext(value: unknown): boolean {
  const forbidden = new Set([
    "contextrefs",
    "routedcontext",
    "routedcontextsnapshot",
    "routedcontextsources",
    "resolvedroutedcontextsources",
    "routedcontextentries",
    "routedcontexttext",
    "admittedtext",
    "sourcecontent",
  ]);
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    if (visited.has(candidate)) return true;
    visited.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    return Object.entries(candidate as Record<string, unknown>).some(
      ([key, nested]) => forbidden.has(key.toLowerCase()) || visit(nested),
    );
  };
  return visit(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
