import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";

/**
 * Citadel Ward `require_approval` effects on integration actions, A2A outbound sends and
 * A2A push deliveries become operator approvals. The approval payload carries the exact
 * request plus a `payloadHash` over it; the executor re-reads the payload, recomputes the
 * hash, re-checks the ward and only then performs the action once.
 */
export const CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND = "citadel_ward.integration_action";
export const CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND = "citadel_ward.a2a_outbound";
export const CITADEL_WARD_A2A_PUSH_APPROVAL_KIND = "citadel_ward.a2a_push";

export type CitadelWardApprovalKind =
  | typeof CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_PUSH_APPROVAL_KIND;

export interface CitadelWardApprovalPayload<TRequest extends Record<string, unknown> = Record<string, unknown>> {
  wardAction: string;
  citadelId: string;
  workspaceId?: string;
  payloadHash: string;
  request: TRequest;
}

export interface CitadelWardApprovalRef {
  approvalId: string;
  wardAction: string;
}

const REPLAY_IDEMPOTENCY_PREFIX = "citadel-ward:";
const WARD_KINDS: readonly string[] = [
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
];

/** SHA-256 hex of the canonical (key-sorted) JSON of the request. */
export function computeCitadelWardPayloadHash(request: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJsonString(request)).digest("hex");
}

export function buildCitadelWardApprovalPayload<T extends Record<string, unknown>>(
  input: Omit<CitadelWardApprovalPayload<T>, "payloadHash">,
): CitadelWardApprovalPayload<T> {
  return { ...input, payloadHash: computeCitadelWardPayloadHash(input.request) };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the payload when well formed, otherwise undefined. Does not verify the hash. */
export function readCitadelWardApprovalPayload(payload: unknown): CitadelWardApprovalPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const { wardAction, citadelId, workspaceId, payloadHash, request } = payload as Record<string, unknown>;
  if (!nonBlank(wardAction) || !nonBlank(citadelId) || !nonBlank(payloadHash)) {
    return undefined;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  if (workspaceId !== undefined && !nonBlank(workspaceId)) {
    return undefined;
  }
  return {
    wardAction,
    citadelId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    payloadHash,
    request: request as Record<string, unknown>,
  };
}

export function citadelWardReplayIdempotencyKey(approvalId: string): string {
  return `${REPLAY_IDEMPOTENCY_PREFIX}${approvalId}`;
}

export function isCitadelWardApprovalKind(kind: string): kind is CitadelWardApprovalKind {
  return WARD_KINDS.includes(kind);
}
