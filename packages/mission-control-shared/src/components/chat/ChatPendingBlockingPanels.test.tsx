// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create as createRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPendingApprovalPanel } from "./ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "./ChatPendingUserInputPanel";

describe("chat pending blocking panels", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("dismisses a dismissible user-input prompt on Escape", async () => {
    const onDismiss = vi.fn();
    const onSubmit = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingUserInputPanel
          pending={false}
          pendingUserInput={{
            turnId: "turn-1",
            promptId: "prompt-1",
            kind: "text",
            title: "Need detail",
            question: "What should happen next?",
            dismissible: true,
          }}
          onSubmit={onSubmit}
          onDismiss={onDismiss}
        />,
      );
    });

    const prompt = container?.querySelector(".chat-user-input-card");
    await act(async () => {
      prompt?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not dismiss a required user-input prompt on Escape", async () => {
    const onDismiss = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingUserInputPanel
          pending={false}
          pendingUserInput={{
            turnId: "turn-1",
            promptId: "prompt-1",
            kind: "text",
            title: "Need detail",
            question: "What should happen next?",
            dismissible: false,
          }}
          onSubmit={vi.fn()}
          onDismiss={onDismiss}
        />,
      );
    });

    const input = container?.querySelector("input");
    input?.focus();
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
  });

  it("submits selected and typed user-input prompt responses", async () => {
    const onSubmit = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingUserInputPanel
          pending={false}
          pendingUserInput={{
            turnId: "turn-1",
            promptId: "prompt-select",
            kind: "single_select",
            title: "Pick path",
            question: "Which path?",
            submitLabel: "Choose",
            options: [
              { optionId: "safe", label: "Safe", description: "Use safe path", helpText: "Lower risk" },
              { optionId: "fast", label: "Fast", description: "Use fast path" },
            ],
          }}
          onSubmit={onSubmit}
        />,
      );
    });

    const submitButton = [...(container?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === "Choose",
    );
    expect(submitButton?.hasAttribute("disabled")).toBe(true);

    const radio = container?.querySelector<HTMLInputElement>('input[type="radio"][value="safe"]');
    await act(async () => {
      radio?.click();
    });
    expect(radio?.checked).toBe(true);
    expect(submitButton?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      submitButton?.click();
    });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "single_select", optionId: "safe" });

    const textRenderer = createRenderer(
      <ChatPendingUserInputPanel
        pending={false}
        pendingUserInput={{
          turnId: "turn-2",
          promptId: "prompt-text",
          kind: "text",
          title: "Need note",
          question: "What note should be attached?",
          placeholder: "Add note",
          expiresAt: "2026-05-14T12:00:00.000Z",
        }}
        onSubmit={onSubmit}
      />,
    );
    const textInput = textRenderer.root.findByProps({ className: "chat-user-input-input" });
    let textSubmit = textRenderer.root.findByProps({ className: "gc-button chat-approval-allow" });
    expect(textSubmit.props.disabled).toBe(true);
    await act(async () => {
      textInput.props.onChange({ target: { value: "  Continue with evidence  " } });
    });
    textSubmit = textRenderer.root.findByProps({ className: "gc-button chat-approval-allow" });
    expect(textSubmit.props.disabled).toBe(false);
    await act(async () => {
      textSubmit.props.onClick();
    });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "text", text: "Continue with evidence" });
    textRenderer.unmount();
  });

  it("does not approve or deny approval prompts on Escape", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingApprovalPanel
          pending={false}
          pendingApproval={{
            approvalId: "approval-1",
            kind: "tool_call",
            toolName: "filesystem.write",
          }}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    const button = [...(container?.querySelectorAll("button") ?? [])].find((item) => item.textContent === "Allow once");
    button?.focus();
    expect(document.activeElement).toBe(button);

    await act(async () => {
      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
  });

  it("wires approval actions to explicit scopes and disables workspace approval without workspace context", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingApprovalPanel
          pending={false}
          pendingApproval={{
            approvalId: "approval-1",
            kind: "tool_call",
            toolName: "filesystem.write",
            reason: "Need to update a release note.",
            riskLevel: "caution",
            remainingCount: 2,
            affectedResources: ["README.md"],
            codePreview: "write README.md",
          }}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    const buttons = [...(container?.querySelectorAll("button") ?? [])];
    const once = buttons.find((item) => item.textContent === "Allow once");
    const session = buttons.find((item) => item.textContent === "Allow in session");
    const workspace = buttons.find((item) => item.textContent === "Allow in workspace");
    const deny = buttons.find((item) => item.textContent === "Deny");

    expect(workspace?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      once?.click();
      session?.click();
      deny?.click();
    });

    expect(onApprove).toHaveBeenCalledWith("once");
    expect(onApprove).toHaveBeenCalledWith("session");
    expect(onApprove).not.toHaveBeenCalledWith("workspace");
    expect(onDeny).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        <ChatPendingApprovalPanel
          pending={false}
          workspaceId="default"
          pendingApproval={{
            approvalId: "approval-2",
            kind: "tool_call",
            toolName: "filesystem.write",
          }}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    const workspaceEnabled = [...(container?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === "Allow in workspace",
    );
    expect(workspaceEnabled?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      workspaceEnabled?.click();
    });
    const confirm = [...(container?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === "Confirm workspace allow",
    );
    await act(async () => {
      confirm?.click();
    });
    expect(onApprove).toHaveBeenCalledWith("workspace");
  });

  it("limits Code Mode approvals to one-time approval controls", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    await act(async () => {
      root?.render(
        <ChatPendingApprovalPanel
          pending={false}
          workspaceId="default"
          pendingApproval={{
            approvalId: "approval-code-mode",
            kind: "code_mode.run",
            codeHash: "code-hash",
            wrapperManifestHash: "wrapper-hash",
            capabilitySnapshotId: "capability-snapshot",
          }}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });

    const buttons = [...(container?.querySelectorAll("button") ?? [])];
    expect(buttons.some((item) => item.textContent === "Allow once")).toBe(true);
    expect(buttons.some((item) => item.textContent === "Allow in session")).toBe(false);
    expect(buttons.some((item) => item.textContent === "Allow in workspace")).toBe(false);

    await act(async () => {
      buttons.find((item) => item.textContent === "Allow once")?.click();
    });
    expect(onApprove).toHaveBeenCalledWith("once");
  });
});
