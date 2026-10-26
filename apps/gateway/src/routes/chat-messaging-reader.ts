import type { FastifyRequest } from "fastify";

/** The reader every request shares when nobody signs in: auth mode none, or a trusted loopback request. */
export const LOCAL_OPERATOR_READER = "local-operator";

/**
 * Whose Messaging read markers a request reads and moves. Access is enforced before the route runs; this only names
 * the reader.
 *
 * - A signed-in operator (token or basic auth) reads as themselves, in the same form the Inbox uses, so each operator
 *   keeps their own markers.
 * - Without sign-in (auth mode none, the shipped default, or a trusted loopback request) there is one local operator,
 *   so every such request reads as that one fixed identity.
 * - Any other caller (a companion, a paired device, a purpose-bound or anonymous token) has no reader identity: the
 *   overview leaves its counts out and a read request is refused.
 */
export function messagingReader(
  request: Pick<FastifyRequest, "authActorSource" | "authActorId" | "authPrincipalPurpose">,
): string | undefined {
  if (request.authPrincipalPurpose) {
    return undefined;
  }
  if (request.authActorSource === "none" || request.authActorSource === "loopback") {
    return LOCAL_OPERATOR_READER;
  }
  const signedIn = request.authActorSource === "token" || request.authActorSource === "basic";
  return signedIn && request.authActorId && request.authActorId !== "anonymous"
    ? JSON.stringify([request.authActorSource, request.authActorId])
    : undefined;
}
