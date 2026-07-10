import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { isGoatError, redactStructuredSecrets } from "@goatcitadel/contracts";

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
    const projected = redactStructuredSecrets(error.toJSON()).value;
    log.warn({ err: projected, code: error.code }, projected.error);
    return reply.code(error.httpStatus).send(projected);
  }

  // Legacy plain Error — retain projected diagnostics server-side and send a
  // generic public body. Error messages/stacks can echo provider credentials.
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error({ err: redactStructuredSecrets(diagnostic).value }, "unhandled route error");
  return reply.code(500).send({ error: "Internal server error" });
}
