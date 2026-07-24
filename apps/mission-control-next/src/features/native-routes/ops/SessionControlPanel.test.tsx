import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionControlDetailResponse } from "@goatcitadel/contracts";
import { SessionControlPanel } from "./SessionControlPanel";

const hookState = vi.hoisted(() => ({
  data: null as SessionControlDetailResponse | null,
  loading: false,
  error: null as string | null,
  reload: vi.fn(async () => undefined),
}));
const apiMocks = vi.hoisted(() => ({
  handoffSessionControl: vi.fn(async () => ({})),
  revokeSessionControl: vi.fn(async () => ({})),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useSessionControlStatus", () => ({
  useSessionControlStatus: () => hookState,
}));
vi.mock("@goatcitadel/mission-control-shared/api/session-control-operator", () => apiMocks);

afterEach(() => {
  hookState.data = null;
  hookState.loading = false;
  hookState.error = null;
  hookState.reload.mockClear();
  apiMocks.handoffSessionControl.mockClear();
  apiMocks.revokeSessionControl.mockClear();
});

function operatorDetailWithPending(readRequested: boolean): SessionControlDetailResponse {
  return {
    control: {
      workspaceId: "workspace-a",
      sessionId: "session-1",
      generation: 1,
      lastEventId: "evt-1",
      lastEventReasonCode: "request_created",
      updatedAt: "2026-07-14T12:00:00.000Z",
      ownerKind: "operator",
      leaseState: "operator_active",
      capabilities: [],
    },
    pendingRequests: [
      {
        requestId: "req-1",
        workspaceId: "workspace-a",
        sessionId: "session-1",
        companionSessionId: "companion-77",
        clientInstanceId: "cli-instance-01",
        tokenFingerprint: "0a1b2c3d",
        requestedCapabilities: readRequested ? ["send", "read"] : ["send"],
        requestedGeneration: 1,
        idempotencyKey: "idem-1",
        expiresAt: "2026-07-14T12:15:00.000Z",
        createdAt: "2026-07-14T12:00:00.000Z",
        status: "pending",
      },
    ],
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
      capabilities: ["send", "read"],
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

function findButton(renderer: ReactTestRenderer, ariaLabel: string) {
  return renderer.root.find((node) => node.type === "button" && node.props["aria-label"] === ariaLabel);
}

describe("SessionControlPanel", () => {
  it("prompts to select a session when none is provided", () => {
    const markup = renderToStaticMarkup(<SessionControlPanel sessionId={undefined} />);
    expect(markup).toContain("No Chat session selected");
  });

  it("renders a pending request with hand off and rejects raw JSON / secrets", () => {
    hookState.data = operatorDetailWithPending(true);
    const markup = renderToStaticMarkup(<SessionControlPanel sessionId="session-1" />);
    expect(markup).toContain("Operator owned");
    expect(markup).toContain("Pending request");
    expect(markup).toContain("Expects generation 1");
    expect(markup).toContain("cli-instance-01");
    expect(markup).toContain("Hand off");
    expect(markup).toContain("Also grant read");
    expect(markup.toLowerCase()).not.toContain("secret");
    expect(markup).not.toMatch(/[0-9a-f]{64}/u);
    // Semantic cards, not a raw JSON dump.
    expect(markup).not.toContain('"requestId"');
  });

  it("hands off with send-only by default and includes read only when granted", () => {
    hookState.data = operatorDetailWithPending(true);
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<SessionControlPanel sessionId="session-1" />);
    });
    act(() => {
      findButton(renderer!, "Hand off control to cli-instance-01").props.onClick();
    });
    expect(apiMocks.handoffSessionControl).toHaveBeenCalledWith("session-1", {
      requestId: "req-1",
      expectedGeneration: 1,
      effectiveCapabilities: ["send"],
    });

    // Toggle "grant read" then hand off again → send + read.
    act(() => {
      const checkbox = renderer!.root.find((node) => node.type === "input");
      checkbox.props.onChange({ target: { checked: true } });
    });
    act(() => {
      findButton(renderer!, "Hand off control to cli-instance-01").props.onClick();
    });
    expect(apiMocks.handoffSessionControl).toHaveBeenLastCalledWith("session-1", {
      requestId: "req-1",
      expectedGeneration: 1,
      effectiveCapabilities: ["send", "read"],
    });
    renderer!.unmount();
  });

  it("exposes revoke and emergency takeover for the current external controller", () => {
    hookState.data = externalDetail();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<SessionControlPanel sessionId="session-1" />);
    });
    act(() => {
      findButton(renderer!, "Emergency takeover").props.onClick();
    });
    expect(apiMocks.revokeSessionControl).toHaveBeenCalledWith("session-1", {
      target: "current_controller",
      expectedGeneration: 4,
      mode: "emergency_takeover",
    });
    act(() => {
      findButton(renderer!, "Revoke external control").props.onClick();
    });
    expect(apiMocks.revokeSessionControl).toHaveBeenLastCalledWith("session-1", {
      target: "current_controller",
      expectedGeneration: 4,
      mode: "revoke",
    });
    renderer!.unmount();
  });
});
