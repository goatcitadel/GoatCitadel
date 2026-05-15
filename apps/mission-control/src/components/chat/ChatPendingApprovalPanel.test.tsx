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
        <ChatPendingApprovalPanel pendingApproval={null} pending={false} onApprove={onApprove} onDeny={onDeny} />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  it("routes approval scopes, denial, and workspace confirmation decisions", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(
        <ChatPendingApprovalPanel
          pendingApproval={{
            approvalId: "approval-2",
            kind: "tool",
            toolName: "filesystem.write",
            reason: "Write release notes",
            riskLevel: "caution",
            affectedResources: ["README.md"],
          }}
          workspaceId="workspace-1"
          pending={false}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    const clickButton = async (label: string) => {
      const button = renderer.root.findAllByType("button").find((candidate) => candidate.props.children === label);
      expect(button).toBeDefined();
      await act(async () => {
        button?.props.onClick?.();
      });
    };

    await clickButton("Allow once");
    await clickButton("Allow in session");
    await clickButton("Allow in workspace");
    expect(JSON.stringify(renderer.toJSON())).toContain("Workspace allow is broader than session allow");

    await clickButton("Cancel");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Workspace allow is broader than session allow");

    await clickButton("Allow in workspace");
    await clickButton("Confirm workspace allow");
    await clickButton("Deny");

    expect(onApprove).toHaveBeenNthCalledWith(1, "once");
    expect(onApprove).toHaveBeenNthCalledWith(2, "session");
    expect(onApprove).toHaveBeenNthCalledWith(3, "workspace");
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
