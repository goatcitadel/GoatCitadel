import type { GatewayCurrentAccess } from "@goatcitadel/contracts";
import type { FastifyRequest } from "fastify";

/** Projection only; existing authentication and route guards determine authority. */
export function projectGatewayCurrentAccess(request: Pick<FastifyRequest, "authActorSource" | "authActorId" | "authDeviceId" | "authGrantId">, operatorAccess: boolean): GatewayCurrentAccess {
  const identified = request.authActorSource !== "none" && request.authActorId !== "anonymous";
  return {
    actorId: identified ? request.authActorId : null,
    actorSource: request.authActorSource,
    operatorAccess,
    readStatusScope: identified && operatorAccess && ["token", "basic"].includes(request.authActorSource)
      ? "operator" : request.authActorSource === "none" || request.authActorSource === "loopback"
        ? "browser_local" : "unavailable",
    ...(request.authDeviceId ? { deviceId: request.authDeviceId } : {}),
    ...(request.authGrantId ? { grantId: request.authGrantId } : {}),
  };
}
