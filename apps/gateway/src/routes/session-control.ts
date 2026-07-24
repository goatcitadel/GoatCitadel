import {
  parseSessionControlHandoffInput,
  parseSessionControlHeartbeatInput,
  parseSessionControlReconnectInput,
  parseSessionControlReleaseInput,
  parseSessionControlRequestInput,
  parseSessionControlRevokeInput,
} from "@goatcitadel/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { markMutationCommitted } from "../plugins/idempotency.js";
import type {
  SessionControlHandoffInput,
  SessionControlHeartbeatInput,
  SessionControlReconnectInput,
  SessionControlReleaseInput,
  SessionControlRequestInput,
  SessionControlRevokeInput,
} from "@goatcitadel/contracts";
import type { SessionControlOperatorActor, SessionControlProtocolActor } from "../services/session-control-service.js";
import { sendRouteError } from "./_error-handler.js";
import { sessionParamsSchema } from "./chat.shared.js";
import {
  readPresentedControlTokenHashSha256,
  resolveSessionControlCompanionActor,
} from "./session-control-request-context.js";
import { streamSessionControlEvents } from "./session-control-event-stream.js";
import { withRouteAccess } from "./route-access.js";

/**
 * HX-411 governed external session-control routes. These are deliberately thin:
 * they set no-store cache headers, select the fail-closed access class, project
 * the authenticated actor, hash the presented control secret from its frozen
 * header, and shape the command. All authorization (principal purpose, delegated
 * capability vs intrinsic protocol op, token hash, companion binding, liveness,
 * and generation CAS) is owned by `SessionControlService` behind
 * `fastify.services.sessionControl`. The session-scoped realtime control-event
 * stream (`GET .../control/events/stream`) shares the same access class and the
 * same single external-read gate; its SSE mechanics live in
 * `./session-control-event-stream.js`.
 */
export function registerSessionControlRoutes(fastify: FastifyInstance): void {
  const companionRoute = withRouteAccess(fastify, "session-control-companion");
  const operatorRoute = withRouteAccess(fastify, "operator");
  const operatorOrCompanionRoute = withRouteAccess(fastify, "operator-or-session-control-companion");

  // POST .../control/requests — session-control-companion. Signed request that
  // stores a pending, session-scoped control request. Does not change ownership.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/requests", companionRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlRequestInput, request.body) as
      | SessionControlRequestInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const actor = resolveSessionControlCompanionActor(request);
      const response = fastify.services.sessionControl.createExternalRequest({
        actor,
        sessionId,
        correlationId: resolveCorrelationId(request),
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // GET .../control — operator-or-session-control-companion. Content-free current
  // owner/generation/lease plus pending requests visible to this actor. A bound
  // controller may read this protocol state without delegated `read`.
  fastify.get("/api/v1/chat/sessions/:sessionId/control", operatorOrCompanionRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    try {
      const detail = fastify.services.sessionControl.getDetail({ actor: resolveControlReadActor(request), sessionId });
      return reply.send(detail);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // GET .../control/events/stream — operator-or-session-control-companion; the
  // external branch additionally requires delegated `read`. Session/workspace-
  // filtered, ordered, retained SSE projection of the content-free control-event
  // log with cursor/replay-gap, bounded unsent buffers, explicit low/high
  // watermarks, and truthful sent/acknowledged/pending diagnostics. No approval
  // action token can appear, and the control secret is never read from the URL.
  fastify.get(
    "/api/v1/chat/sessions/:sessionId/control/events/stream",
    operatorOrCompanionRoute,
    async (request, reply) => {
      const sessionId = parseSessionId(reply, request);
      if (sessionId === undefined) {
        return;
      }
      let actor: SessionControlProtocolActor;
      try {
        actor = resolveControlReadActor(request);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
      return streamSessionControlEvents(fastify, request, reply, { sessionId, actor });
    },
  );

  // POST .../control/handoff — operator only. CASes the exact operator generation
  // plus pending request into one external generation.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/handoff", operatorRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlHandoffInput, request.body) as
      | SessionControlHandoffInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const response = fastify.services.sessionControl.handoff({
        actor: resolveOperatorActor(request),
        sessionId,
        correlationId: resolveCorrelationId(request),
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // POST .../control/heartbeat — session-control-companion. Bound companion plus
  // control token and exact generation; renews only the live lease.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/heartbeat", companionRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlHeartbeatInput, request.body) as
      | SessionControlHeartbeatInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const actor = resolveSessionControlCompanionActor(request);
      const presentedTokenHashSha256 = readPresentedControlTokenHashSha256(request);
      const response = fastify.services.sessionControl.heartbeat({
        actor,
        sessionId,
        correlationId: resolveCorrelationId(request),
        presentedTokenHashSha256,
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // POST .../control/reconnect — session-control-companion. Same bound companion,
  // signed body, valid old token, exact generation N, new token hash. Supersedes
  // N and creates same-bound external N+1 inside the reconnect window.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/reconnect", companionRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlReconnectInput, request.body) as
      | SessionControlReconnectInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const actor = resolveSessionControlCompanionActor(request);
      const presentedTokenHashSha256 = readPresentedControlTokenHashSha256(request);
      const response = fastify.services.sessionControl.reconnect({
        actor,
        sessionId,
        correlationId: resolveCorrelationId(request),
        presentedTokenHashSha256,
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // POST .../control/release — session-control-companion. Bound companion, signed
  // request, control token, exact generation; returns ownership to a new operator
  // generation.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/release", companionRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlReleaseInput, request.body) as
      | SessionControlReleaseInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const actor = resolveSessionControlCompanionActor(request);
      const presentedTokenHashSha256 = readPresentedControlTokenHashSha256(request);
      const response = fastify.services.sessionControl.release({
        actor,
        sessionId,
        correlationId: resolveCorrelationId(request),
        presentedTokenHashSha256,
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // POST .../control/revoke — operator only. Revokes a pending request or the
  // current external generation; `mode: "emergency_takeover"` creates a new
  // operator generation.
  fastify.post("/api/v1/chat/sessions/:sessionId/control/revoke", operatorRoute, async (request, reply) => {
    setControlCacheHeaders(reply);
    const sessionId = parseSessionId(reply, request);
    if (sessionId === undefined) {
      return;
    }
    const input = parseControlBody(reply, parseSessionControlRevokeInput, request.body) as
      | SessionControlRevokeInput
      | undefined;
    if (input === undefined) {
      return;
    }
    try {
      const response = fastify.services.sessionControl.revoke({
        actor: resolveOperatorActor(request),
        sessionId,
        correlationId: resolveCorrelationId(request),
        input,
      });
      markMutationCommitted(request);
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}

function setControlCacheHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

function parseSessionId(reply: FastifyReply, request: FastifyRequest): string | undefined {
  const params = sessionParamsSchema.safeParse(request.params);
  if (!params.success) {
    void reply.code(400).send({ error: params.error.flatten() });
    return undefined;
  }
  return params.data.sessionId;
}

function parseControlBody<TOutput>(
  reply: FastifyReply,
  parse: (input: unknown) => TOutput,
  body: unknown,
): TOutput | undefined {
  try {
    return parse(body);
  } catch {
    void reply.code(400).send({ error: "Session control request body is invalid." });
    return undefined;
  }
}

/**
 * The authenticated local operator. The access class already guaranteed operator
 * control-plane authority (token/basic/loopback or auth-none); the service still
 * re-checks operator authority. Purpose-bound companions never reach here — the
 * central purpose guard rejects them from the `operator` class.
 */
function resolveOperatorActor(request: FastifyRequest): SessionControlOperatorActor {
  return { actorKind: "operator", actorId: request.authActorId };
}

/**
 * The read actor for GET .../control. Operators read directly; a purpose-bound
 * companion is projected to its stored-identity actor so the service can gate the
 * read against the bound controller or its own pending request.
 */
function resolveControlReadActor(request: FastifyRequest) {
  if (request.authActorSource === "companion" && request.authPrincipalPurpose === "session_control_client") {
    return resolveSessionControlCompanionActor(request);
  }
  return resolveOperatorActor(request);
}

function resolveCorrelationId(request: FastifyRequest): string {
  const value = request.headers["x-goatcitadel-correlation-id"];
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : request.id;
}
