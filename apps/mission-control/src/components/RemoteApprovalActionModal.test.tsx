import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ui", () => ({
  GCModal: ({
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    confirmPending,
    confirmDisabled,
    dismissDisabled,
    onOpenChange,
    onConfirm,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    confirmPending?: boolean;
    confirmDisabled?: boolean;
    dismissDisabled?: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: () => void | Promise<void>;
    children?: React.ReactNode;
  }) =>
    open ? (
      <section>
        <h1>{title}</h1>
        <p>{description}</p>
        <button type="button" disabled={dismissDisabled} onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </button>
        <button type="button" disabled={confirmPending || confirmDisabled} onClick={() => void onConfirm?.()}>
          {confirmPending ? "Working..." : confirmLabel}
        </button>
        {children}
      </section>
    ) : null,
}));

import { RemoteApprovalActionModal } from "./RemoteApprovalActionModal";

describe("RemoteApprovalActionModal", () => {
  it("shows remote approval details and wires approve, reject, and dismiss actions", () => {
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onDismiss = vi.fn();
    const renderer = create(
      <RemoteApprovalActionModal
        open
        prompt={{
          approvalId: "approval-remote-1",
          actionType: "approval.resolve",
          tokenId: "token-1",
          token: "secret-token",
          kind: "shell.exec",
          riskLevel: "danger",
          status: "pending",
          preview: { command: "pnpm test" },
          expiresAt: "2026-04-01T12:05:00.000Z",
        }}
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("shell.exec is ready for a Mission Control decision");
    expect(text).toContain("approval-remote-1");
    expect(text).toContain("token-1");
    expect(text).toContain("pnpm test");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Approve action"))
        ?.props.onClick();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Reject action"))
        ?.props.onClick();
    });
    expect(onReject).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Dismiss"))
        ?.props.onClick();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("disables approval actions for expired tokens and shows busy fallback copy", () => {
    vi.setSystemTime(new Date("2026-04-01T12:10:00.000Z"));
    const renderer = create(
      <RemoteApprovalActionModal
        open
        busy
        prompt={{
          approvalId: "approval-expired",
          actionType: "approval.resolve",
          tokenId: "token-expired",
          token: "secret-token",
          kind: "browser.use",
          riskLevel: "high",
          status: "pending",
          expiresAt: "2026-04-01T12:05:00.000Z",
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const buttons = renderer.root.findAllByType("button");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("browser.use is no longer actionable");
    expect(text).toContain("This approval token expired.");
    expect(buttons.find((button) => button.children.includes("Working..."))?.props.disabled).toBe(true);
    expect(buttons.find((button) => button.children.includes("Reject action"))).toBeUndefined();
  });

  it("uses generic copy when the prompt is missing", () => {
    const renderer = create(
      <RemoteApprovalActionModal open onApprove={vi.fn()} onReject={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("A remote approval action is ready.");
  });
});
