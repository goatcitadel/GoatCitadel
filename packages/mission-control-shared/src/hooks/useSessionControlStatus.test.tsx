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

  it("clears data and hides upstream error detail when the scoped read fails", async () => {
    apiMocks.fetchSessionControlDetail.mockRejectedValueOnce(new Error("token=sk-secret-should-not-surface"));
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-1" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(latest?.data).toBeNull();
    expect(latest?.error).toBe("The session control status is unavailable.");
    expect(latest?.error).not.toMatch(/secret|token/i);
    renderer!.unmount();
  });
});
