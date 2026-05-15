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
    onOpenChange: (open: boolean) => void;
    onConfirm?: () => void | Promise<void>;
    children?: React.ReactNode;
  }) =>
    open ? (
      <section>
        <h1>{title}</h1>
        <p>{description}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </button>
        <button type="button" disabled={confirmPending} onClick={() => void onConfirm?.()}>
          {confirmPending ? "Working..." : confirmLabel}
        </button>
        {children}
      </section>
    ) : null,
}));

import { DeviceAccessApprovalModal } from "./DeviceAccessApprovalModal";

describe("DeviceAccessApprovalModal", () => {
  it("shows device details and wires approve, reject, and dismiss actions", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onDismiss = vi.fn();
    const renderer = create(
      <DeviceAccessApprovalModal
        open
        prompt={{
          approvalId: "approval-1",
          requestId: "request-1",
          deviceLabel: "Operator laptop",
          deviceType: "desktop",
          platform: "Windows",
          requestedIp: "127.0.0.1",
          requestedOrigin: "http://localhost:5173",
        }}
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Operator laptop is waiting for an authenticated session");
    expect(text).toContain("Platform");
    expect(text).toContain("Windows");
    expect(text).toContain("Remote IP");
    expect(text).toContain("http://localhost:5173");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Allow device"))
        ?.props.onClick();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Reject device"))
        ?.props.onClick();
    });
    expect(onReject).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Not now"))
        ?.props.onClick();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses fallback copy and busy labels when details are unavailable", () => {
    const renderer = create(
      <DeviceAccessApprovalModal open busy onApprove={vi.fn()} onReject={vi.fn()} onDismiss={vi.fn()} />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("A new device is requesting access.");
    expect(text).toContain("Working...");
  });
});
