import type { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";

/**
 * The narrow control-domain surface the HX-411 session-control routes call. It
 * is exactly the controller-protocol subset of {@link SessionControlRuntimeOwner}
 * (which itself is a thin stateless pass-through to the sole
 * `SessionControlService` owner). Routes stay thin: they select the access
 * class, project the authenticated actor, hash the presented control secret, and
 * shape the command — every generation/token/binding/capability CAS lives in the
 * service and storage layers behind this port.
 */
export type SessionControlRouteService = Pick<
  SessionControlRuntimeOwner,
  "createExternalRequest" | "handoff" | "heartbeat" | "reconnect" | "release" | "revoke" | "getControl" | "getDetail"
>;
