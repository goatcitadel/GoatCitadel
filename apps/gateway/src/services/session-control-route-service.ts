import type { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";

/**
 * The controller-protocol operations the HX-411 session-control routes call.
 * This list is the single source of truth for both the compile-time port type
 * and the runtime projection below, so the two cannot drift apart.
 */
export const sessionControlRouteMethods = [
  "createExternalRequest",
  "handoff",
  "heartbeat",
  "reconnect",
  "release",
  "revoke",
  "authorizeExternalSessionRead",
  "getDetail",
  "pageControlEventStream",
] as const;

export type SessionControlRouteMethod = (typeof sessionControlRouteMethods)[number];

/**
 * The narrow control-domain surface the HX-411 session-control routes call. It
 * is exactly the controller-protocol subset of {@link SessionControlRuntimeOwner}
 * (which itself is a thin stateless pass-through to the sole
 * `SessionControlService` owner). Routes stay thin: they select the access
 * class, project the authenticated actor, hash the presented control secret, and
 * shape the command — every generation/token/binding/capability CAS lives in the
 * service and storage layers behind this port.
 */
export type SessionControlRouteService = Pick<SessionControlRuntimeOwner, SessionControlRouteMethod>;

/**
 * Projects a runtime owner down to exactly {@link sessionControlRouteMethods}.
 *
 * `Pick<>` narrows only the compile-time surface. Binding the owner instance
 * itself to the route seam leaves every other method on its prototype — turn
 * admission, request-lease heartbeats, durable-run binding, turn-write closure,
 * expired-admission cancellation — reachable through `fastify.services.sessionControl`
 * at runtime. Turn-admission authority is not the route layer's to hold, so
 * routes receive a frozen own-property projection that delegates to the owner
 * and exposes nothing else.
 */
export function createSessionControlRouteService(owner: SessionControlRouteService): SessionControlRouteService {
  const service: SessionControlRouteService = {
    createExternalRequest: (command) => owner.createExternalRequest(command),
    handoff: (command) => owner.handoff(command),
    heartbeat: (command) => owner.heartbeat(command),
    reconnect: (command) => owner.reconnect(command),
    release: (command) => owner.release(command),
    revoke: (command) => owner.revoke(command),
    authorizeExternalSessionRead: (query) => owner.authorizeExternalSessionRead(query),
    getDetail: (query) => owner.getDetail(query),
    pageControlEventStream: (query) => owner.pageControlEventStream(query),
  };
  return Object.freeze(service);
}
