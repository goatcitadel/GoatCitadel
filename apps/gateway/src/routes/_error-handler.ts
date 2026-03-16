import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { isGoatError } from "@goatcitadel/contracts";

/**
 * Shared route error handler.  Maps GoatError subclasses to the appropriate
 * HTTP status + JSON body.  For untyped errors falls back to 500.
 *
 * Usage:  `} catch (error) { return sendRouteError(reply, error, request.log); }`
 */
export function sendRouteError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyBaseLogger,
): ReturnType<FastifyReply["send"]> {
  if (isGoatError(error)) {
    log.warn({ err: error, code: error.code }, error.message);
    return reply.code(error.httpStatus).send(error.toJSON());
  }

  // Legacy plain Error — log full details server-side, send generic message
  log.error({ err: error }, "unhandled route error");
  return reply.code(500).send({ error: "Internal server error" });
}
