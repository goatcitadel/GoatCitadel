import type { SessionControlDetailResponse } from "@goatcitadel/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useChatExternalSessionControl } from "./useChatExternalSessionControl";
import { useChatSessionSelection } from "./useChatSessionSelection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { revoke, reload } = vi.hoisted(() => ({ revoke: vi.fn(), reload: vi.fn(async () => undefined) }));
vi.mock("@goatcitadel/mission-control-shared/api/session-control-operator", () => ({ revokeSessionControl: revoke }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useSessionControlStatus", () => ({
  useSessionControlStatus: (sessionId: string | null) => ({
    data: sessionId
      ? ({
          control: {
            workspaceId: "workspace-a",
            sessionId,
            generation: 4,
            ownerKind: "external_companion",
            leaseState: "external_live",
            capabilities: ["send"],
            lastEventId: "event-1",
            lastEventReasonCode: "handoff",
            updatedAt: "2026-07-14T12:00:00.000Z",
            boundExternalController: {
              clientInstanceId: "client-a",
              companionSessionId: "companion-a",
              principalPurpose: "session_control_client",
              tokenFingerprint: "fixture",
            },
            lastHeartbeatAt: "2026-07-14T12:00:00.000Z",
            leaseExpiresAt: "2026-07-14T12:01:00.000Z",
            reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
          },
          pendingRequests: [],
        } satisfies SessionControlDetailResponse)
      : null,
    reload,
  }),
}));

it.each(["resolve", "reject"] as const)(
  "keeps a switched conversation independent when an old revoke %ss",
  async (outcome) => {
    reload.mockClear();
    let settle!: () => void;
    revoke.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle = outcome === "resolve" ? () => resolve(undefined) : () => reject(new Error("revoke rejected"));
        }),
    );
    const refreshChatSessionAggregate = vi.fn(async () => undefined);
    const coordination = { sessionControlSendLockedRef: { current: false } };
    let selection!: ReturnType<typeof useChatSessionSelection>;
    let control!: ReturnType<typeof useChatExternalSessionControl>;
    function Harness() {
      selection = useChatSessionSelection({});
      control = useChatExternalSessionControl({ selection, coordination, refreshChatSessionAggregate });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => selection.setSelectedSessionId("session-a"));
    await act(async () => {
      control.handleSessionControlRevoke();
      await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
    });
    expect(control.sessionControlActionPending).toBe("revoke");
    await act(async () => selection.setSelectedSessionId("session-b"));
    const pendingAfterSwitch = control.sessionControlActionPending;
    await act(async () => settle());
    expect(pendingAfterSwitch).toBeNull();
    expect(control.sessionControlActionError).toBeNull();
    expect(control.sessionControlSendLocked).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(refreshChatSessionAggregate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  },
);
