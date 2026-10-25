import type { FastifyReply, FastifyRequest } from "fastify";
import { isAllowedGatewayOrigin } from "../cors-origin-guard.js";

function readRequestOrigin(request: FastifyRequest): string | undefined {
  const raw = request.headers.origin || request.headers.referer;
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** The caller's Mission Control origin, only when the Gateway's shared origin policy allows it. */
export function allowedRequestOrigin(request: FastifyRequest): string | undefined {
  const origin = readRequestOrigin(request);
  if (!origin) return undefined;
  try {
    return isAllowedGatewayOrigin(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A browser request that names an origin the Gateway does not allow can never be handed its sign-in
 * result (the redirect would end on "Sign-in not found"), so refuse to start the flow with a clear 400.
 * Requests with no Origin/Referer (non-browser clients) are left alone: they simply get no hand-off.
 */
export function rejectDisallowedRequestOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  const hasHeader = Boolean(request.headers.origin || request.headers.referer);
  if (!hasHeader || allowedRequestOrigin(request)) return false;
  void reply.code(400).send({
    error:
      "This page's origin is not allowed to complete sign-in. Open GoatCitadel from an allowed origin (see GOATCITADEL_ALLOWED_ORIGINS) and try again.",
  });
  return true;
}
