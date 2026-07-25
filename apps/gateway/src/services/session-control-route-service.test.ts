import { describe, expect, it, vi } from "vitest";
import {
  createSessionControlRouteService,
  sessionControlRouteMethods,
  type SessionControlRouteMethod,
} from "./session-control-route-service.js";
import { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import type { SessionControlService } from "./session-control-service.js";

/**
 * Turn-admission authority that must never be reachable from the route seam.
 * Named explicitly so a broken prototype walk cannot make the drift guard below
 * pass vacuously.
 */
const TURN_AUTHORITY_METHODS = [
  "admitOperatorChatTurn",
  "admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery",
  "admitChatTurn",
  "admitSystemChatTurn",
  "admitSystemHeartbeatOccurrence",
  "startRequestLeaseHeartbeat",
  "renewRequestLease",
  "bindDurableRun",
  "withDurableClaim",
  "assertActiveTurnWrite",
  "closeTurnWrite",
  "cancelExpiredUnboundTurnAdmissions",
] as const;

describe("createSessionControlRouteService", () => {
  it("exposes exactly the declared controller-protocol subset", () => {
    const service = createSessionControlRouteService(ownerOverStubService().owner);

    expect(Object.keys(service).sort()).toEqual([...sessionControlRouteMethods].sort());
    expect(Object.getPrototypeOf(service)).toBe(Object.prototype);
    expect(Object.isFrozen(service)).toBe(true);
  });

  it("keeps every non-controller owner method off the route seam", () => {
    const service = createSessionControlRouteService(ownerOverStubService().owner);
    const reachable = service as unknown as Record<string, unknown>;
    const routeMethods = new Set<string>(sessionControlRouteMethods);

    for (const name of ownerMethodNames()) {
      if (routeMethods.has(name)) continue;
      expect(reachable[name], name).toBeUndefined();
    }

    for (const name of TURN_AUTHORITY_METHODS) {
      expect(ownerMethodNames(), name).toContain(name);
      expect(reachable[name], name).toBeUndefined();
    }
  });

  it("delegates every controller-protocol operation to the owner unchanged", () => {
    const { owner, control } = ownerOverStubService();
    const service = createSessionControlRouteService(owner);

    for (const method of sessionControlRouteMethods) {
      const command = { marker: method };
      const result = (service[method] as (input: unknown) => unknown)(command);
      expect(result).toBe(`result:${method}`);
      expect(control[method]).toHaveBeenCalledWith(command);
      expect(control[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the owner binding when a route detaches a projected method", () => {
    const { owner, control } = ownerOverStubService();
    const { heartbeat, pageControlEventStream } = createSessionControlRouteService(owner);

    expect(heartbeat({ marker: "detached" } as never)).toBe("result:heartbeat");
    expect(pageControlEventStream({ marker: "detached" } as never)).toBe("result:pageControlEventStream");
    expect(control.heartbeat).toHaveBeenCalledWith({ marker: "detached" });
    expect(control.pageControlEventStream).toHaveBeenCalledWith({ marker: "detached" });
  });
});

function ownerOverStubService(): {
  owner: SessionControlRuntimeOwner;
  control: Record<SessionControlRouteMethod, ReturnType<typeof vi.fn>>;
} {
  const control = Object.fromEntries(
    sessionControlRouteMethods.map((method) => [method, vi.fn(() => `result:${method}`)]),
  ) as Record<SessionControlRouteMethod, ReturnType<typeof vi.fn>>;
  return {
    owner: new SessionControlRuntimeOwner(control as unknown as SessionControlService),
    control,
  };
}

function ownerMethodNames(): string[] {
  return Object.getOwnPropertyNames(SessionControlRuntimeOwner.prototype).filter((name) => name !== "constructor");
}
