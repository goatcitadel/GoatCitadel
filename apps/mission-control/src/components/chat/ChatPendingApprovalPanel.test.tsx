import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPendingApprovalPanel } from "./ChatPendingApprovalPanel";

describe("ChatPendingApprovalPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders when a pending approval exists and clears when it does not", async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer = create(<div />);
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    await act(async () => {
      renderer = create(
        <ChatPendingApprovalPanel
          pendingApproval={{
            approvalId: "approval-1",
            toolName: "browser.navigate",
            reason: "Needs approval",
            expiresAt: "2026-03-22T12:15:00.000Z",
          }}
          pending={false}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    expect(renderer.root.findAllByType("button").length).toBeGreaterThan(0);
    expect(renderer.toJSON()).not.toBeNull();

    await act(async () => {
      renderer.update(
        <ChatPendingApprovalPanel
          pendingApproval={null}
          pending={false}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });
});
