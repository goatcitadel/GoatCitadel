import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/chat/SurfaceReconnectBanner", () => ({
  SurfaceReconnectBanner: ({ mode, status, onRefresh }: any) => (
    <div>
      reconnect:{mode}:{status.state}
      <button type="button" onClick={onRefresh}>
        refresh-stream
      </button>
    </div>
  ),
}));

vi.mock("../../components/chat/ChatThreadView", () => ({
  ChatThreadView: ({
    mode,
    loading,
    selectedTurnId,
    notices,
    queuedCount,
    streamError,
    onBottomStateChange,
    onSelectTurn,
    onSwitchBranch,
    onRetryTurn,
    onEditTurn,
    onOpenRunDetails,
    onOpenGeneratedArtifact,
    onCreateGeneratedArtifact,
    onCreateGeneratedArtifactVersion,
  }: any) => (
    <section>
      <h2>
        thread:{mode}:{loading ? "loading" : "ready"}
      </h2>
      <p>selected:{selectedTurnId ?? "none"}</p>
      <p>notices:{notices.length}</p>
      <p>queued:{queuedCount}</p>
      {streamError ? <p>{streamError}</p> : null}
      <button type="button" onClick={() => onBottomStateChange(false)}>
        bottom-state
      </button>
      <button type="button" onClick={() => onSelectTurn("turn-2")}>
        select-turn
      </button>
      <button type="button" onClick={() => onSwitchBranch("turn-2")}>
        switch-branch
      </button>
      <button type="button" onClick={() => onRetryTurn("turn-2")}>
        retry-turn
      </button>
      <button type="button" onClick={() => onEditTurn("turn-2")}>
        edit-turn
      </button>
      <button type="button" onClick={() => onOpenRunDetails("turn-2")}>
        open-run
      </button>
      <button type="button" onClick={() => onOpenGeneratedArtifact("turn-2")}>
        open-artifact
      </button>
      <button type="button" onClick={() => onCreateGeneratedArtifact("turn-2")}>
        create-artifact
      </button>
      <button type="button" onClick={() => onCreateGeneratedArtifactVersion("turn-2")}>
        version-artifact
      </button>
    </section>
  ),
}));

vi.mock("../../components/chat/ChatPendingApprovalPanel", () => ({
  ChatPendingApprovalPanel: ({ pendingApproval, workspaceId, pending, onApprove, onDeny }: any) => (
    <aside>
      approval:{pendingApproval.approvalId}:{workspaceId}:{pending ? "pending" : "idle"}
      <button type="button" onClick={() => onApprove("workspace")}>
        approve-workspace
      </button>
      <button type="button" onClick={onDeny}>
        deny-approval
      </button>
    </aside>
  ),
}));

vi.mock("../../components/chat/ChatPendingUserInputPanel", () => ({
  ChatPendingUserInputPanel: ({ pendingUserInput, pending, onSubmit }: any) => (
    <aside>
      input:{pendingUserInput?.requestId ?? "none"}:{pending ? "pending" : "idle"}
      <button type="button" onClick={() => onSubmit({ kind: "text", text: "operator reply" })}>
        submit-input
      </button>
    </aside>
  ),
}));

import { ChatThreadShell } from "./ChatThreadShell";

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join("");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join("");
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === label);
}

function buildProps(
  overrides: Partial<Parameters<typeof ChatThreadShell>[0]> = {},
): Parameters<typeof ChatThreadShell>[0] {
  return {
    mode: "cowork" as const,
    loading: false,
    thread: null,
    selectedTurnId: "turn-1",
    delegationRun: null,
    notices: [{ id: "notice-1", tone: "info", message: "Watch this branch." }] as any,
    followOutput: true,
    streamStatus: "streaming" as const,
    queuedCount: 2,
    streamError: "stream interrupted",
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "workspace-1",
    approvalPending: false,
    userInputPending: false,
    eventStreamStatus: { state: "retrying", reconnectAttempts: 2 },
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

describe("ChatThreadShell", () => {
  it("renders reconnect, thread, and user-input lanes while forwarding thread actions", () => {
    const props = buildProps({
      pendingUserInput: { requestId: "input-1" } as any,
      userInputPending: true,
    });
    const renderer = create(<ChatThreadShell {...props} />);

    expect(rendererText(renderer)).toContain("reconnect:cowork:retrying");
    expect(rendererText(renderer)).toContain("thread:cowork:ready");
    expect(rendererText(renderer)).toContain("input:input-1:pending");
    expect(rendererText(renderer)).not.toContain("approval:");

    act(() => {
      findButton(renderer, "refresh-stream")?.props.onClick();
      findButton(renderer, "bottom-state")?.props.onClick();
      findButton(renderer, "select-turn")?.props.onClick();
      findButton(renderer, "switch-branch")?.props.onClick();
      findButton(renderer, "retry-turn")?.props.onClick();
      findButton(renderer, "edit-turn")?.props.onClick();
      findButton(renderer, "open-run")?.props.onClick();
      findButton(renderer, "open-artifact")?.props.onClick();
      findButton(renderer, "create-artifact")?.props.onClick();
      findButton(renderer, "version-artifact")?.props.onClick();
      findButton(renderer, "submit-input")?.props.onClick();
    });

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onBottomStateChange).toHaveBeenCalledWith(false);
    expect(props.onSelectTurn).toHaveBeenCalledWith("turn-2");
    expect(props.onSwitchBranch).toHaveBeenCalledWith("turn-2");
    expect(props.onRetryTurn).toHaveBeenCalledWith("turn-2");
    expect(props.onEditTurn).toHaveBeenCalledWith("turn-2");
    expect(props.onOpenRunDetails).toHaveBeenCalledWith("turn-2");
    expect(props.onOpenGeneratedArtifact).toHaveBeenCalledWith("turn-2");
    expect(props.onCreateGeneratedArtifact).toHaveBeenCalledWith("turn-2");
    expect(props.onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-2");
    expect(props.onSubmitUserInput).toHaveBeenCalledWith({ kind: "text", text: "operator reply" });

    renderer.unmount();
  });

  it("prioritizes pending approvals over user input and forwards approval actions", () => {
    const props = buildProps({
      pendingApproval: { approvalId: "approval-1" } as any,
      pendingUserInput: { requestId: "input-1" } as any,
      approvalPending: true,
    });
    const renderer = create(<ChatThreadShell {...props} />);

    expect(rendererText(renderer)).toContain("approval:approval-1:workspace-1:pending");
    expect(rendererText(renderer)).not.toContain("input:input-1");

    act(() => {
      findButton(renderer, "approve-workspace")?.props.onClick();
      findButton(renderer, "deny-approval")?.props.onClick();
    });

    expect(props.onApprovePending).toHaveBeenCalledWith("workspace");
    expect(props.onDenyPending).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
