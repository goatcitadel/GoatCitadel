/**
 * HX-411 operator-scoped session-control client.
 *
 * These calls are made with the operator's NORMAL Mission Control authentication
 * (the shared `request` transport injects operator bearer/correlation headers).
 * They deliberately carry NO control secret and NO control token header — that is
 * exclusively the external CLI/harness client's concern
 * (`./session-control.ts`). The operator reads status and drives the two
 * operator-only actions (handoff, revoke/emergency-takeover) that the shipped
 * Gateway routes expose:
 *
 *  - GET   /api/v1/chat/sessions/:sessionId/control            (status projection)
 *  - POST  /api/v1/chat/sessions/:sessionId/control/handoff    (operator only)
 *  - POST  /api/v1/chat/sessions/:sessionId/control/revoke     (operator only)
 *
 * Every payload is validated with the frozen contract parsers so the operator UI
 * can never send malformed control material (e.g. a read-only capability set) nor
 * trust an unvalidated, content-bearing, or secret-leaking response.
 */
import type {
  ExternalSessionControlCapability,
  SessionControlDetailResponse,
  SessionControlHandoffResponse,
  SessionControlRevokeResponse,
} from "@goatcitadel/contracts";
import {
  readIdleOperatorControlDetail,
  snapshotSessionControlData,
} from "@goatcitadel/contracts/session-control-operator-projection";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision } from "./access-scope.js";
import { getGatewayApiBaseUrl, request } from "./client-core.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

type ControlProtocol = typeof import("@goatcitadel/contracts/session-control");
let protocol: ControlProtocol | undefined;
let protocolLoad: Promise<ControlProtocol> | undefined;

function loadControlProtocol() {
  return (protocolLoad ??= import("@goatcitadel/contracts/session-control").then(
    (loaded) => (protocol = loaded),
    (error: unknown) => {
      protocolLoad = undefined;
      throw error;
    },
  ));
}

function captureOperatorScope() {
  const installation = getGatewayApiBaseUrl();
  const caller = getGatewayCallerScopeRevision();
  const access = getGatewayAccessRevision();
  return () => {
    if (
      installation !== getGatewayApiBaseUrl() ||
      caller !== getGatewayCallerScopeRevision() ||
      access !== getGatewayAccessRevision()
    ) {
      throw new DOMException("Gateway operator access changed.", "AbortError");
    }
  };
}

function controlPath(sessionId: string, suffix: string): string {
  const trimmed = sessionId.trim();
  if (!SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error("Session control requires a valid session id.");
  }
  return `/api/v1/chat/sessions/${encodeURIComponent(trimmed)}/control${suffix}`;
}

/**
 * Fresh, contract-shaped idempotency key. The transport also stamps an
 * `Idempotency-Key` HTTP header; the body key is the durable control idempotency
 * material so exact operator retries converge on one transition.
 */
function newControlIdempotencyKey(): string {
  return `op-ctl-${crypto.randomUUID()}`;
}

async function postControl<TResponse>(
  path: string,
  body: unknown,
  parse: (payload: unknown) => TResponse,
): Promise<TResponse> {
  const payload = await request<unknown>(path, { method: "POST", body: JSON.stringify(body) });
  return parse(payload);
}

/** Read the content-free current owner / generation / lease state and any pending requests. */
export async function fetchSessionControlDetail(sessionId: string): Promise<SessionControlDetailResponse> {
  const assertCurrent = captureOperatorScope();
  const payload = await request<unknown>(controlPath(sessionId, ""));
  assertCurrent();
  const idle = readIdleOperatorControlDetail(payload);
  if (idle) return idle;
  const { parseSessionControlDetailResponse } = protocol ?? (await loadControlProtocol());
  assertCurrent();
  return parseSessionControlDetailResponse(payload);
}

export interface OperatorSessionControlHandoffInput {
  readonly requestId: string;
  readonly expectedGeneration: number;
  /** Effective capabilities the operator grants; must include `send`, may include `read`. */
  readonly effectiveCapabilities: readonly ExternalSessionControlCapability[];
  readonly idempotencyKey?: string;
}

/** Approve a pending external control request, CASing operator generation → external N+1. */
export async function handoffSessionControl(
  sessionId: string,
  input: OperatorSessionControlHandoffInput,
): Promise<SessionControlHandoffResponse> {
  let effectiveCapabilities: unknown;
  try {
    effectiveCapabilities = snapshotSessionControlData(input.effectiveCapabilities);
  } catch {
    throw new TypeError("Session control handoff is invalid.");
  }
  const intent = {
    requestId: input.requestId,
    expectedGeneration: input.expectedGeneration,
    effectiveCapabilities,
    idempotencyKey: input.idempotencyKey ?? newControlIdempotencyKey(),
  };
  const assertCurrent = captureOperatorScope();
  const { parseSessionControlHandoffInput, parseSessionControlHandoffResponse } =
    protocol ?? (await loadControlProtocol());
  const body = parseSessionControlHandoffInput(intent);
  assertCurrent();
  return postControl(controlPath(sessionId, "/handoff"), body, parseSessionControlHandoffResponse);
}

export type OperatorSessionControlRevokeInput =
  | { readonly target: "request"; readonly requestId: string; readonly idempotencyKey?: string }
  | {
      readonly target: "current_controller";
      readonly expectedGeneration: number;
      readonly mode: "revoke" | "emergency_takeover";
      readonly idempotencyKey?: string;
    };

/**
 * Revoke a pending request or the current external controller. `mode:
 * "emergency_takeover"` is the explicit operator takeover path; both modes create
 * a new operator generation server-side.
 */
export async function revokeSessionControl(
  sessionId: string,
  input: OperatorSessionControlRevokeInput,
): Promise<SessionControlRevokeResponse> {
  const idempotencyKey = input.idempotencyKey ?? newControlIdempotencyKey();
  const intent =
    input.target === "request"
      ? { target: "request", requestId: input.requestId, idempotencyKey }
      : {
          target: "current_controller",
          expectedGeneration: input.expectedGeneration,
          mode: input.mode,
          idempotencyKey,
        };
  const assertCurrent = captureOperatorScope();
  const { parseSessionControlRevokeInput, parseSessionControlRevokeResponse } = protocol ?? (await loadControlProtocol());
  const body = parseSessionControlRevokeInput(intent);
  assertCurrent();
  return postControl(controlPath(sessionId, "/revoke"), body, parseSessionControlRevokeResponse);
}
