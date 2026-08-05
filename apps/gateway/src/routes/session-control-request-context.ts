import { createHash } from "node:crypto";
import {
  ConflictError,
  SESSION_CONTROL_CLIENT_INSTANCE_HEADER,
  SESSION_CONTROL_GENERATION_HEADER,
  SESSION_CONTROL_TOKEN_HEADER,
  ValidationError,
  parseSessionControlGenerationHeader,
  type SessionControlConflictCode,
} from "@goatcitadel/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAuthenticatedOperatorAdmissionContext,
  createExternalCompanionAdmissionContext,
  type AuthenticatedOperatorAdmissionContext,
  type ExternalCompanionAdmissionContext,
  type SessionControlExternalCompanionActor,
} from "../services/session-control-service.js";
import { sendRouteError } from "./_error-handler.js";

// The plaintext control secret is NEVER carried in the client-instance header;
// only the frozen `X-GoatCitadel-Session-Control-Token` header carries the
// secret, and this route hashes it before it reaches the service. The
// client-instance value is public (it appears in content-free control
// projections), so it needs no redaction — the durable CAS in storage is the
// real authority that matches it against the bound grant.
const SESSION_CONTROL_TOKEN_HEADER_KEY = SESSION_CONTROL_TOKEN_HEADER.toLowerCase();
const SESSION_CONTROL_GENERATION_HEADER_KEY = SESSION_CONTROL_GENERATION_HEADER.toLowerCase();
const SESSION_CONTROL_CLIENT_INSTANCE_HEADER_KEY = SESSION_CONTROL_CLIENT_INSTANCE_HEADER.toLowerCase();

export function sessionControlConflict(code: SessionControlConflictCode, message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message, details: { sessionControlCode: code } });
}

/** True when the request presents an authenticated purpose-bound control companion. */
export function isSessionControlCompanionRequest(request: FastifyRequest): boolean {
  return (
    request.authActorSource === "companion" &&
    request.authPrincipalPurpose === "session_control_client" &&
    Boolean(request.authCompanionSessionId)
  );
}

function readSingleHeader(request: FastifyRequest, key: string): string | undefined {
  const value = request.headers[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the plaintext control secret from its frozen dedicated header and reduce
 * it to a lowercase SHA-256 hash before it is handed to any service command.
 * The plaintext is never returned, logged, or placed in a body. A missing/empty
 * header fails closed as an invalid token rather than hashing an empty string.
 */
export function readPresentedControlTokenHashSha256(request: FastifyRequest): string {
  const plaintext = readSingleHeader(request, SESSION_CONTROL_TOKEN_HEADER_KEY);
  if (!plaintext) {
    throw sessionControlConflict("SESSION_CONTROL_TOKEN_INVALID", "Session control token is invalid.");
  }
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Parse the canonical decimal controller generation from its frozen header. */
export function readPresentedControlGeneration(request: FastifyRequest): number {
  try {
    return parseSessionControlGenerationHeader(request.headers[SESSION_CONTROL_GENERATION_HEADER_KEY]);
  } catch {
    throw new ValidationError({
      field: SESSION_CONTROL_GENERATION_HEADER,
      message: "Session control generation header is invalid.",
    });
  }
}

/**
 * Project the authenticated, purpose-bound companion binding plus the presented
 * client-instance header into the stored-identity actor the service expects. The
 * companion session and parent device grant are authenticated (never body/header
 * claimed); the client instance is a client-chosen identifier the durable CAS
 * validates against the bound grant.
 */
export function resolveSessionControlCompanionActor(request: FastifyRequest): SessionControlExternalCompanionActor {
  const companionSessionId = request.authCompanionSessionId?.trim();
  const deviceGrantId = request.authGrantId?.trim();
  if (!isSessionControlCompanionRequest(request) || !companionSessionId || !deviceGrantId) {
    throw sessionControlConflict(
      "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
      "Session control principal purpose is denied.",
    );
  }
  const clientInstanceId = readSingleHeader(request, SESSION_CONTROL_CLIENT_INSTANCE_HEADER_KEY);
  if (!clientInstanceId) {
    throw new ValidationError({
      field: SESSION_CONTROL_CLIENT_INSTANCE_HEADER,
      message: "Session control client instance header is required.",
    });
  }
  return {
    actorKind: "external_companion",
    companionSessionId,
    deviceGrantId,
    clientInstanceId,
    principalPurpose: "session_control_client",
  };
}

/**
 * Build the branded external-companion send admission context for a canonical
 * `agent-send`. Returns `undefined` for operators and generic companions so the
 * caller keeps the unchanged operator send path. For a purpose-bound companion
 * it fails closed (throwing a typed control error) when the control token,
 * client instance, or generation is missing/invalid — before canonical
 * admission is ever reached.
 */
export function resolveExternalCompanionAdmissionContext(
  request: FastifyRequest,
): ExternalCompanionAdmissionContext | undefined {
  if (request.authActorSource !== "companion" || request.authPrincipalPurpose !== "session_control_client") {
    return undefined;
  }
  const actor = resolveSessionControlCompanionActor(request);
  const tokenHashSha256 = readPresentedControlTokenHashSha256(request);
  const expectedGeneration = readPresentedControlGeneration(request);
  return createExternalCompanionAdmissionContext({
    companionSessionId: actor.companionSessionId,
    deviceGrantId: actor.deviceGrantId,
    clientInstanceId: actor.clientInstanceId,
    tokenHashSha256,
    expectedGeneration,
  });
}

/**
 * Mint the branded authenticated-operator admission context. `chat.messages.ts`
 * sits at its module-size ceiling, so the security-sensitive operator context is
 * minted in this dedicated route-layer helper — reachable only from the
 * authenticated Chat routes, never from a service an unauthenticated path could
 * call. Returns `undefined` for any non-operator source.
 */
export function resolveAuthenticatedOperatorAdmissionContext(
  request: FastifyRequest,
): AuthenticatedOperatorAdmissionContext | undefined {
  if (!request.authActorId?.trim() || !["none", "token", "basic", "loopback"].includes(request.authActorSource)) {
    return undefined;
  }
  return createAuthenticatedOperatorAdmissionContext({
    actorId: request.authActorId,
    authActorSource: request.authActorSource,
  });
}

/**
 * Trailing admission arguments for the canonical send owners. An operator send
 * keeps its exact historical shape (one trailing authenticated-operator context);
 * an external controller send appends the branded external-companion context in
 * the slot the send pipeline already threads through, with no operator context.
 */
export function resolveSendAdmissionArgs(
  request: FastifyRequest,
  externalCompanion: ExternalCompanionAdmissionContext | undefined,
):
  | readonly [AuthenticatedOperatorAdmissionContext | undefined]
  | readonly [undefined, ExternalCompanionAdmissionContext] {
  return externalCompanion ? [undefined, externalCompanion] : [resolveAuthenticatedOperatorAdmissionContext(request)];
}

/**
 * HX-411 external transcript-read gate. Operators keep normal reads and pass
 * through untouched. A purpose-bound `session_control_client` companion is
 * projected to its stored-identity actor and delegated to the single
 * authoritative service gate `authorizeExternalSessionRead`, which owns the
 * session-binding and delegated-`read` checks shared with control events and the
 * future session-scoped stream. Returns `true` (and sends the mapped error) when
 * the read is denied; the route handler then returns without reading content.
 */
export async function rejectExternalTranscriptRead(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): Promise<boolean> {
  if (!isSessionControlCompanionRequest(request)) {
    return false;
  }
  try {
    const actor = resolveSessionControlCompanionActor(request);
    await fastify.services.sessionControl.authorizeExternalSessionRead({ actor, sessionId });
    return false;
  } catch (error) {
    sendRouteError(reply, error, request.log);
    return true;
  }
}
