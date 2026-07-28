import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps, PropsWithChildren } from "react";

vi.mock("@goatcitadel/mission-control-shared/components/ui", () => ({
  Dialog: ({ children }: PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
  DialogFooter: ({ children, ...props }: ComponentProps<"footer">) => <footer {...props}>{children}</footer>,
  DialogHeader: ({ children, ...props }: ComponentProps<"header">) => <header {...props}>{children}</header>,
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { ChatTimerPanel } from "./ChatTimerPanel";

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.root);
}

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : collectText(child))).join(" ");
}

describe("ChatTimerPanel", () => {
  it("shows provider-free confirmation controls and active timer cancellation", () => {
    const onCreate = vi.fn();
    const onCancelTimer = vi.fn();
    const renderer = create(
      <ChatTimerPanel
        panel={{
          open: true,
          busy: false,
          error: null,
          dueAt: "2026-07-28T17:30",
          timezone: "America/Los_Angeles",
          message: "Review proof",
          notificationRuleId: "",
          cancelOnNextReply: true,
          rules: [{ ruleId: "rule-1", label: "Away alerts" }],
          timers: [
            {
              timerId: "timer-1",
              workspaceId: "workspace-1",
              sessionId: "session-1",
              revision: 2,
              dueAt: "2026-07-29T00:30:00.000Z",
              timezone: "America/Los_Angeles",
              message: "Existing timer",
              cancelOnNextReply: false,
              status: "active",
              createdBy: "operator",
              createdAt: "2026-07-28T00:00:00.000Z",
              updatedAt: "2026-07-28T00:00:00.000Z",
            },
          ],
          onDueAtChange: vi.fn(),
          onTimezoneChange: vi.fn(),
          onMessageChange: vi.fn(),
          onNotificationRuleChange: vi.fn(),
          onCancelOnNextReplyChange: vi.fn(),
          onCreate,
          onCancelTimer,
          onClose: vi.fn(),
        }}
      />,
    );
    expect(text(renderer)).toContain("never invokes a provider or model");
    expect(text(renderer)).toContain("Cancel only after my next message commits successfully");
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Create timer"))
      ?.props.onClick();
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel"))
      ?.props.onClick();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCancelTimer).toHaveBeenCalledWith("timer-1", 2);
  });
});
