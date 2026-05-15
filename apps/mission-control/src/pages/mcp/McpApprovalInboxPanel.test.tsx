import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalInboxItemRecord } from "@goatcitadel/contracts";
import { McpApprovalInboxPanel } from "./McpApprovalInboxPanel";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON());
}

function reactNodeText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => reactNodeText(child)).join(" ");
  }
  if (typeof value === "object" && "props" in value) {
    return reactNodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => reactNodeText(node.props.children).includes(label));
  if (!button) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return button;
}

function inboxItem(overrides: Partial<ApprovalInboxItemRecord> = {}): ApprovalInboxItemRecord {
  return {
    inboxItemId: "inbox-1",
    approvalId: "approval-1",
    connectorId: "connector-1",
    receiverKind: "mcp",
    receiverId: "server-1",
    tokenId: "token-1",
    token: "secret-token",
    actionType: "approval.resolve",
    state: "pending",
    approvalKind: "tool.invoke",
    riskLevel: "caution",
    approvalStatus: "pending",
    preview: {
      title: "Deploy artifact",
      description: "Approve the deploy run",
    },
    createdAt: "2026-05-14T20:00:00.000Z",
    updatedAt: "2026-05-14T20:01:00.000Z",
    expiresAt: "2026-05-14T21:00:00.000Z",
    deliveryCount: 2,
    lastDeliveredAt: "2026-05-14T20:02:00.000Z",
    ...overrides,
  };
}

describe("McpApprovalInboxPanel", () => {
  it("blocks loading guidance when the server is disconnected and updates the inbox filter", () => {
    const setInboxFilterState = vi.fn();
    const onRefresh = vi.fn(async () => undefined);
    const renderer = create(
      <McpApprovalInboxPanel
        selectedStatus="disconnected"
        inboxFilterState="pending"
        setInboxFilterState={setInboxFilterState}
        inboxBusy={false}
        inboxError="Inbox unavailable"
        inboxItems={[]}
        pendingInboxActionId={null}
        onRefresh={onRefresh}
        onResolve={vi.fn()}
      />,
    );

    expect(rendererText(renderer)).toContain("Connect this server before loading approval inbox items.");
    expect(rendererText(renderer)).toContain("Inbox unavailable");

    act(() => {
      renderer.root.findByType("select").props.onChange({ target: { value: "approved" } });
      findButton(renderer, "Refresh Inbox").props.onClick();
    });

    expect(setInboxFilterState).toHaveBeenCalledWith("approved");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("renders pending inbox actions and disables other rows while one action is pending", () => {
    const onResolve = vi.fn(async () => undefined);
    const itemA = inboxItem();
    const itemB = inboxItem({
      inboxItemId: "inbox-2",
      approvalId: "approval-2",
      tokenId: "token-2",
      state: "pending",
      riskLevel: "danger",
      deliveryCount: 4,
      preview: { summary: "Delete stale workspace" },
      lastError: "previous delivery failed",
    });
    const renderer = create(
      <McpApprovalInboxPanel
        selectedStatus="connected"
        inboxFilterState="pending"
        setInboxFilterState={vi.fn()}
        inboxBusy={false}
        inboxError={null}
        inboxItems={[itemA, itemB]}
        pendingInboxActionId={null}
        onRefresh={vi.fn(async () => undefined)}
        onResolve={onResolve}
      />,
    );

    expect(rendererText(renderer)).toContain("Deploy artifact");
    expect(rendererText(renderer)).toContain("deliveries");
    expect(rendererText(renderer)).toContain("4");
    expect(rendererText(renderer)).toContain("previous delivery failed");

    const approveButtons = renderer.root
      .findAllByType("button")
      .filter((node) => reactNodeText(node.props.children).includes("Approve"));
    const rejectButtons = renderer.root
      .findAllByType("button")
      .filter((node) => reactNodeText(node.props.children).includes("Reject"));

    expect(approveButtons).toHaveLength(2);
    expect(rejectButtons).toHaveLength(2);
    const firstApprove = approveButtons[0];
    const firstReject = rejectButtons[0];
    const secondReject = rejectButtons[1];
    expect(firstApprove).toBeDefined();
    expect(firstReject).toBeDefined();
    expect(secondReject).toBeDefined();
    expect(firstApprove!.props.disabled).toBe(false);
    expect(firstReject!.props.disabled).toBe(false);

    act(() => {
      secondReject!.props.onClick();
    });

    expect(onResolve).toHaveBeenCalledWith(itemB, "reject");

    act(() => {
      renderer.update(
        <McpApprovalInboxPanel
          selectedStatus="connected"
          inboxFilterState="pending"
          setInboxFilterState={vi.fn()}
          inboxBusy={false}
          inboxError={null}
          inboxItems={[itemA, itemB]}
          pendingInboxActionId="inbox-2"
          onRefresh={vi.fn(async () => undefined)}
          onResolve={onResolve}
        />,
      );
    });

    const actionButtons = renderer.root
      .findAllByType("button")
      .filter((node) => String(node.props.className ?? "").includes("gc-action-button"));
    expect(actionButtons.map((node) => node.props.disabled)).toEqual([false, true, true, true, true]);

    renderer.unmount();
  });

  it("shows resolved metadata and the connected empty state", () => {
    const resolved = inboxItem({
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-05-14T20:10:00.000Z",
      resolvedBy: "operator",
    });

    const resolvedRenderer = create(
      <McpApprovalInboxPanel
        selectedStatus="connected"
        inboxFilterState="all"
        setInboxFilterState={vi.fn()}
        inboxBusy={false}
        inboxError={null}
        inboxItems={[resolved]}
        pendingInboxActionId={null}
        onRefresh={vi.fn(async () => undefined)}
        onResolve={vi.fn()}
      />,
    );

    expect(rendererText(resolvedRenderer)).toContain("Resolved");
    expect(rendererText(resolvedRenderer)).toContain("by operator");
    expect(
      resolvedRenderer.root
        .findAllByType("button")
        .some((node) => reactNodeText(node.props.children).includes("Approve")),
    ).toBe(false);

    resolvedRenderer.unmount();

    const emptyRenderer = create(
      <McpApprovalInboxPanel
        selectedStatus="connected"
        inboxFilterState="failed"
        setInboxFilterState={vi.fn()}
        inboxBusy={false}
        inboxError={null}
        inboxItems={[]}
        pendingInboxActionId={null}
        onRefresh={vi.fn(async () => undefined)}
        onResolve={vi.fn()}
      />,
    );

    expect(rendererText(emptyRenderer)).toContain("No approval inbox items matched the current filter.");

    emptyRenderer.unmount();
  });
});
