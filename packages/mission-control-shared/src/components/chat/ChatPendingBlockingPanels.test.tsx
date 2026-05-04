// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
});
