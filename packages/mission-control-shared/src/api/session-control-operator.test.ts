import { beforeEach, describe, expect, it, vi } from "vitest";

import * as operator from "./session-control-operator";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

const HEARTBEAT = "2026-07-14T12:00:00.000Z";
const LEASE_EXPIRES = "2026-07-14T12:01:00.000Z";
const RECONNECT_EXPIRES = "2026-07-14T12:05:00.000Z";

function externalControl(generation: number) {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-1",
    generation,
    lastEventId: "evt-2",
    lastEventReasonCode: "handoff",
    updatedAt: HEARTBEAT,
    ownerKind: "external_companion",
    leaseState: "external_live",
    capabilities: ["send"],
    boundExternalController: {
      companionSessionId: "companion-77",
      clientInstanceId: "cli-instance-01",
      principalPurpose: "session_control_client",
      tokenFingerprint: "0a1b2c3d",
    },
    lastHeartbeatAt: HEARTBEAT,
    leaseExpiresAt: LEASE_EXPIRES,
    reconnectExpiresAt: RECONNECT_EXPIRES,
  };
}

function activatedRequest() {
  return {
    requestId: "req-1",
    workspaceId: "workspace-a",
    sessionId: "session-1",
    companionSessionId: "companion-77",
    clientInstanceId: "cli-instance-01",
    tokenFingerprint: "0a1b2c3d",
    requestedCapabilities: ["send"],
    requestedGeneration: 1,
    idempotencyKey: "idem-1",
    expiresAt: "2026-07-14T12:15:00.000Z",
    createdAt: HEARTBEAT,
    status: "activated",
    activatedGeneration: 2,
    decidedAt: "2026-07-14T12:00:30.000Z",
    decidedByActorId: "operator-1",
    decisionReasonCode: "handoff",
  };
}

function operatorControl(generation: number, reason: string) {
  return {
    workspaceId: "workspace-a",
    sessionId: "session-1",
    generation,
    lastEventId: "evt-3",
    lastEventReasonCode: reason,
    updatedAt: HEARTBEAT,
    ownerKind: "operator",
    leaseState: "operator_active",
    capabilities: [],
  };
}

function lastCall(): [string, RequestInit | undefined] {
  const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
  return [path as string, init as RequestInit | undefined];
}

function body(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

beforeEach(() => {
  apiMocks.request.mockReset();
});

describe("operator session-control client", () => {
  it("reads the content-free control detail with operator auth (GET, no control token)", async () => {
    apiMocks.request.mockResolvedValue({ control: operatorControl(1, "session_initialized"), pendingRequests: [] });
    const detail = await operator.fetchSessionControlDetail("session-1");

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/control");
    expect(init?.method ?? "GET").toBe("GET");
    expect(detail.control.ownerKind).toBe("operator");
    // No token header/material is ever attached by the operator client.
    expect(JSON.stringify(init ?? {})).not.toMatch(/session-control-token/iu);
  });

  it("hands off a pending request with a generated idempotency key and validated capabilities", async () => {
    apiMocks.request.mockResolvedValue({ request: activatedRequest(), control: externalControl(2) });
    const response = await operator.handoffSessionControl("session-1", {
      requestId: "req-1",
      expectedGeneration: 1,
      effectiveCapabilities: ["send"],
    });

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/control/handoff");
    expect(init?.method).toBe("POST");
    const sent = body(init);
    expect(sent.requestId).toBe("req-1");
    expect(sent.expectedGeneration).toBe(1);
    expect(sent.effectiveCapabilities).toEqual(["send"]);
    expect(typeof sent.idempotencyKey).toBe("string");
    expect((sent.idempotencyKey as string).length).toBeGreaterThan(0);
    expect(response.control.generation).toBe(2);
  });

  it("rejects a read-only capability set before making any request", async () => {
    await expect(
      operator.handoffSessionControl("session-1", {
        requestId: "req-1",
        expectedGeneration: 1,
        effectiveCapabilities: ["read"] as never,
      }),
    ).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("revokes a pending request", async () => {
    apiMocks.request.mockResolvedValue({
      target: "request",
      request: {
        requestId: "req-1",
        workspaceId: "workspace-a",
        sessionId: "session-1",
        companionSessionId: "companion-77",
        clientInstanceId: "cli-instance-01",
        tokenFingerprint: "0a1b2c3d",
        requestedCapabilities: ["send"],
        requestedGeneration: 1,
        idempotencyKey: "idem-1",
        expiresAt: "2026-07-14T12:15:00.000Z",
        createdAt: HEARTBEAT,
        status: "cancelled",
        decidedAt: "2026-07-14T12:00:30.000Z",
        decidedByActorId: "operator-1",
        decisionReasonCode: "request_cancelled",
      },
    });
    await operator.revokeSessionControl("session-1", { target: "request", requestId: "req-1" });

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/control/revoke");
    expect(init?.method).toBe("POST");
    expect(body(init)).toMatchObject({ target: "request", requestId: "req-1" });
  });

  it("performs an emergency takeover against the exact external generation", async () => {
    apiMocks.request.mockResolvedValue({
      target: "current_controller",
      revokedGeneration: 2,
      mode: "emergency_takeover",
      control: operatorControl(3, "emergency_takeover"),
    });
    const response = await operator.revokeSessionControl("session-1", {
      target: "current_controller",
      expectedGeneration: 2,
      mode: "emergency_takeover",
    });

    const sent = body(lastCall()[1]);
    expect(sent).toMatchObject({ target: "current_controller", expectedGeneration: 2, mode: "emergency_takeover" });
    expect(response.target).toBe("current_controller");
    if (response.target === "current_controller") {
      expect(response.control.ownerKind).toBe("operator");
      expect(response.control.generation).toBe(3);
    }
  });

  it("rejects an invalid session id before making any request", async () => {
    await expect(operator.fetchSessionControlDetail("bad session id!")).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });
});
