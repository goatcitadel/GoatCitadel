import { describe, expect, it } from "vitest";
import { parseSessionControlDetailResponse, type SessionControlDetailResponse } from "@goatcitadel/contracts";
import { deriveSessionControlBannerViewModel } from "./session-control-banner";

const HEARTBEAT = "2026-07-14T12:00:00.000Z";
const LEASE_EXPIRES = "2026-07-14T12:01:00.000Z"; // heartbeat + 60s
const RECONNECT_EXPIRES = "2026-07-14T12:05:00.000Z"; // heartbeat + 300s
const SECRET_LOOKALIKE = "control-secret-DO-NOT-LEAK";

function externalDetail(
  overrides: {
    leaseState?: "external_live" | "external_stale";
    lastEventReasonCode?: "handoff" | "lease_stale";
    capabilities?: readonly ["send"] | readonly ["send", "read"];
    generation?: number;
  } = {},
): SessionControlDetailResponse {
  const leaseState = overrides.leaseState ?? "external_live";
  return parseSessionControlDetailResponse({
    control: {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      generation: overrides.generation ?? 2,
      lastEventId: "evt-1",
      lastEventReasonCode:
        overrides.lastEventReasonCode ?? (leaseState === "external_stale" ? "lease_stale" : "handoff"),
      updatedAt: HEARTBEAT,
      ownerKind: "external_companion",
      leaseState,
      capabilities: overrides.capabilities ?? ["send"],
      boundExternalController: {
        companionSessionId: "companion-77",
        clientInstanceId: "cli-instance-01",
        principalPurpose: "session_control_client",
        tokenFingerprint: "0a1b2c3d",
      },
      lastHeartbeatAt: HEARTBEAT,
      leaseExpiresAt: LEASE_EXPIRES,
      reconnectExpiresAt: RECONNECT_EXPIRES,
    },
    pendingRequests: [],
  });
}

function operatorDetail(pending: number): SessionControlDetailResponse {
  const pendingRequests = Array.from({ length: pending }, (_unused, index) => ({
    requestId: `req-${index}`,
    workspaceId: "workspace-a",
    sessionId: "session-1",
    companionSessionId: "companion-77",
    clientInstanceId: `cli-instance-${index}`,
    tokenFingerprint: "0a1b2c3d",
    requestedCapabilities: ["send", "read"] as const,
    requestedGeneration: 1,
    idempotencyKey: `idem-${index}`,
    expiresAt: "2026-07-14T12:15:00.000Z",
    createdAt: "2026-07-14T12:00:00.000Z",
    status: "pending" as const,
  }));
  return parseSessionControlDetailResponse({
    control: {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      generation: 1,
      lastEventId: "evt-0",
      lastEventReasonCode: pending > 0 ? "request_created" : "session_initialized",
      updatedAt: HEARTBEAT,
      ownerKind: "operator",
      leaseState: "operator_active",
      capabilities: [],
    },
    pendingRequests,
  });
}

describe("deriveSessionControlBannerViewModel", () => {
  it("treats absence as operator-owned and does not lock send", () => {
    for (const value of [null, undefined]) {
      const model = deriveSessionControlBannerViewModel(value);
      expect(model.externalControlActive).toBe(false);
      expect(model.sendLocked).toBe(false);
      expect(model.sendLockReason).toBeNull();
      expect(model.tone).toBe("operator");
    }
  });

  it("projects an operator-owned session with pending request count and no lock", () => {
    const model = deriveSessionControlBannerViewModel(operatorDetail(2));
    expect(model.externalControlActive).toBe(false);
    expect(model.sendLocked).toBe(false);
    expect(model.ownerLabel).toBe("Operator");
    expect(model.generation).toBe(1);
    expect(model.generationLabel).toBe("Generation 1");
    expect(model.pendingRequestCount).toBe(2);
    expect(model.clientInstanceId).toBeNull();
    expect(model.capabilitiesLabel).toBeNull();
  });

  it("locks send and projects truthful live external control state", () => {
    const model = deriveSessionControlBannerViewModel(externalDetail({ capabilities: ["send", "read"] }));
    expect(model.externalControlActive).toBe(true);
    expect(model.sendLocked).toBe(true);
    expect(model.tone).toBe("external-live");
    expect(model.ownerLabel).toBe("External controller");
    expect(model.generationLabel).toBe("Generation 2");
    expect(model.leaseStateLabel).toBe("Live lease");
    expect(model.capabilitiesLabel).toBe("Send + Read");
    expect(model.clientInstanceId).toBe("cli-instance-01");
    expect(model.companionSessionId).toBe("companion-77");
    expect(model.tokenFingerprint).toBe("0a1b2c3d");
    expect(model.lastHeartbeatAt).toBe(HEARTBEAT);
    expect(model.leaseExpiresAt).toBe(LEASE_EXPIRES);
    expect(model.reconnectExpiresAt).toBe(RECONNECT_EXPIRES);
    expect(model.sendLockReason).toContain("owns this session");
  });

  it("keeps send locked when the external lease is stale (absence never returns ownership)", () => {
    const model = deriveSessionControlBannerViewModel(externalDetail({ leaseState: "external_stale" }));
    expect(model.sendLocked).toBe(true);
    expect(model.tone).toBe("external-stale");
    expect(model.leaseStateLabel).toBe("Stale — reconnect window open");
    expect(model.capabilitiesLabel).toBe("Send");
    expect(model.sendLockReason).toContain("revoke or take over");
  });

  it("never projects a control secret into any field", () => {
    const model = deriveSessionControlBannerViewModel(externalDetail());
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(SECRET_LOOKALIKE);
    expect(serialized.toLowerCase()).not.toContain("secret");
    // The public fingerprint is 8 hex chars — never a full 64-char hash.
    expect(model.tokenFingerprint).toMatch(/^[0-9a-f]{8}$/u);
  });
});
