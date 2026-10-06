import { Activity } from "react";
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

  it("keeps the same session's status when a retained Chat is shown again (CH-47)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
      apiMocks.fetchSessionControlDetail.mockResolvedValue(externalDetail());
      let latest: HookValue | undefined;
      const view = (mode: "visible" | "hidden") => (
        <Activity mode={mode}>
          <Harness sessionId="session-1" onValue={(value) => (latest = value)} />
        </Activity>
      );
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(view("visible"));
      });
      await flush();
      expect(latest?.data?.control.ownerKind).toBe("external_companion");
      expect(apiMocks.fetchSessionControlDetail).toHaveBeenCalledTimes(1);

      await act(async () => renderer.update(view("hidden")));
      vi.setSystemTime(new Date("2026-10-05T10:00:20Z"));
      await act(async () => renderer.update(view("visible")));
      await flush();
      expect(apiMocks.fetchSessionControlDetail).toHaveBeenCalledTimes(1);
      expect(latest?.data?.control.ownerKind).toBe("external_companion");

      await act(async () => renderer.update(view("hidden")));
      vi.setSystemTime(new Date("2026-10-05T10:00:51Z"));
      let release!: () => void;
      apiMocks.fetchSessionControlDetail.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(externalDetail());
          }),
      );
      await act(async () => renderer.update(view("visible")));
      await flush();
      expect(apiMocks.fetchSessionControlDetail).toHaveBeenCalledTimes(2);
      // The known external lock stays while it is read again.
      expect(latest?.data?.control.ownerKind).toBe("external_companion");
      expect(latest?.loading).toBe(false);
      await act(async () => release());
      await flush();
      expect(latest?.data?.control.ownerKind).toBe("external_companion");
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the first session after a quick switch away and back, and drops the superseded read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
      apiMocks.fetchSessionControlDetail.mockResolvedValueOnce(externalDetail());
      let releaseOther!: () => void;
      apiMocks.fetchSessionControlDetail.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOther = () => resolve(operatorDetail());
          }),
      );
      apiMocks.fetchSessionControlDetail.mockResolvedValueOnce(externalDetail());
      let latest: HookValue | undefined;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />);
      });
      await flush();
      expect(latest?.data?.control.ownerKind).toBe("external_companion");

      vi.setSystemTime(new Date("2026-10-05T10:00:05Z"));
      await act(async () => renderer.update(<Harness sessionId="session-2" onValue={(value) => (latest = value)} />));
      await flush();
      vi.setSystemTime(new Date("2026-10-05T10:00:10Z"));
      await act(async () => renderer.update(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />));
      await flush();

      expect(apiMocks.fetchSessionControlDetail).toHaveBeenNthCalledWith(3, "session-1");
      expect(latest?.loading).toBe(false);
      expect(latest?.data?.control.ownerKind).toBe("external_companion");
      await act(async () => releaseOther());
      await flush();
      // The other session's late answer never replaces the selected session's lock.
      expect(latest?.data?.control.ownerKind).toBe("external_companion");
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
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
