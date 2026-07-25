import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionControlDetailResponse } from "@goatcitadel/contracts";
import { useSessionControlStatus } from "./useSessionControlStatus";

const apiMocks = vi.hoisted(() => ({ fetchSessionControlDetail: vi.fn() }));

vi.mock("../api/session-control-operator", () => ({
  fetchSessionControlDetail: apiMocks.fetchSessionControlDetail,
}));
vi.mock("./useRefreshSubscription", () => ({ useRefreshSubscription: vi.fn() }));

type HookValue = ReturnType<typeof useSessionControlStatus>;

function Harness({ sessionId, onValue }: { sessionId: string | null; onValue: (value: HookValue) => void }) {
  onValue(useSessionControlStatus(sessionId));
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function operatorDetail(): SessionControlDetailResponse {
  return {
    control: {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      generation: 1,
      lastEventId: "evt-0",
      lastEventReasonCode: "session_initialized",
      updatedAt: "2026-07-14T12:00:00.000Z",
      ownerKind: "operator",
      leaseState: "operator_active",
      capabilities: [],
    },
    pendingRequests: [],
  } as unknown as SessionControlDetailResponse;
}

function externalDetail(): SessionControlDetailResponse {
  return {
    control: {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      generation: 4,
      lastEventId: "evt-2",
      lastEventReasonCode: "handoff",
      updatedAt: "2026-07-14T12:00:00.000Z",
      ownerKind: "external_companion",
      leaseState: "external_live",
      capabilities: ["send"],
      boundExternalController: {
        companionSessionId: "companion-77",
        clientInstanceId: "cli-instance-01",
        principalPurpose: "session_control_client",
        tokenFingerprint: "0a1b2c3d",
      },
      lastHeartbeatAt: "2026-07-14T12:00:00.000Z",
      leaseExpiresAt: "2026-07-14T12:01:00.000Z",
      reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
    },
    pendingRequests: [],
  } as unknown as SessionControlDetailResponse;
}

describe("useSessionControlStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays idle and performs no read when no session is selected", async () => {
    let latest: HookValue | undefined;
    await act(async () => {
      create(<Harness sessionId={null} onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(apiMocks.fetchSessionControlDetail).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(false);
    expect(latest?.data).toBeNull();
  });

  it("loads the control detail for the selected session", async () => {
    apiMocks.fetchSessionControlDetail.mockResolvedValueOnce(operatorDetail());
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(apiMocks.fetchSessionControlDetail).toHaveBeenCalledWith("session-1");
    expect(latest?.data?.control.sessionId).toBe("session-1");
    renderer!.unmount();
  });

  it("falls back to unlocked null only on a never-loaded initial read failure", async () => {
    apiMocks.fetchSessionControlDetail.mockRejectedValueOnce(new Error("token=sk-secret-should-not-surface"));
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />);
    });
    await flush();
    // Nothing was ever loaded, so null (→ unlocked operator fallback) is correct.
    expect(latest?.data).toBeNull();
    expect(latest?.error).toBe("The session control status is unavailable.");
    expect(latest?.error).not.toMatch(/secret|token/i);
    renderer!.unmount();
  });

  it("retains the last locked projection through a transient re-poll failure and recovers on success (H1)", async () => {
    apiMocks.fetchSessionControlDetail
      .mockResolvedValueOnce(externalDetail())
      .mockRejectedValueOnce(new Error("transient token=sk-should-not-surface"))
      .mockResolvedValueOnce(operatorDetail());
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />);
    });
    await flush();
    // Initial load: external controller owns the session (locked, no error).
    expect(latest?.data?.control.ownerKind).toBe("external_companion");
    expect(latest?.error).toBeNull();

    // Transient re-poll failure MUST NOT drop the known lock: data is retained and
    // the failure surfaces as a non-fatal caveat (banner stays, sendLocked stays true).
    await act(async () => {
      await latest!.reload();
    });
    await flush();
    expect(latest?.data?.control.ownerKind).toBe("external_companion");
    expect(latest?.error).toBe("The session control status is unavailable.");
    expect(latest?.error).not.toMatch(/secret|token/i);

    // A subsequent successful reload clears the error and replaces the data
    // (no stale-data-forever bug).
    await act(async () => {
      await latest!.reload();
    });
    await flush();
    expect(latest?.data?.control.ownerKind).toBe("operator");
    expect(latest?.error).toBeNull();
    renderer!.unmount();
  });
});
