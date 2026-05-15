import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchApprovals: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  fetchDevDiagnostics: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  resolveApproval: vi.fn(),
  resolveApprovalsBulk: vi.fn(),
  resumeDurableRun: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    message,
    confirmLabel,
    cancelLabel,
    pending,
    onConfirm,
    onCancel,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    pending?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) =>
    open ? (
      <div>
        <div>{title}</div>
        <div>{message}</div>
        <button type="button" disabled={pending} onClick={onCancel}>
          {cancelLabel ?? "Cancel"}
        </button>
        <button type="button" disabled={pending} onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
}));

import { ApprovalsPage } from "./ApprovalsPage";

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
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeText(child)).join(" ");
  }
  if (node && typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && nodeText(node.props.children).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick?.();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-loop32",
    kind: "shell.exec",
    riskLevel: "caution",
    status: "pending",
    preview: {},
    payload: {},
    explanationStatus: "not_requested",
    explanation: null,
    explanationError: null,
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("ApprovalsPage loop 32 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { search: "" },
    });
    apiMocks.fetchApprovalReplay.mockResolvedValue({ events: [], effects: [], approval: makeApproval() });
    apiMocks.fetchDevDiagnostics.mockResolvedValue({ items: [] });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({ items: [] });
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: { approvalId: "approval-loop32" },
      query: { approvalId: "approval-loop32" },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: [],
        proactiveRunIds: [],
        approvalIds: ["approval-loop32"],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
  });

  it("recovers from an empty-state refresh failure through the same local refresh action", async () => {
    let shouldFailRefresh = false;
    apiMocks.fetchApprovals.mockImplementation(async () => {
      if (shouldFailRefresh) {
        shouldFailRefresh = false;
        throw new Error("approval service unavailable");
      }
      return { items: [] };
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ApprovalsPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("No pending approvals");

      shouldFailRefresh = true;
      await clickButton(renderer, "Refresh approvals");
      await flush();
      expect(rendererText(renderer)).toContain("approval service unavailable");

      await clickButton(renderer, "Refresh approvals");
      await flush();
      const text = rendererText(renderer);
      expect(text).toContain("No pending approvals");
      expect(text).toContain("The approvals queue is clear right now.");
      expect(text).not.toContain("approval service unavailable");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("keeps empty-state navigation local between pending, history, and recovery views", async () => {
    apiMocks.fetchApprovals.mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ApprovalsPage />);
      });
      await flush();

      await clickButton(renderer, "Review history");
      await flush();
      expect(rendererText(renderer)).toContain("No approval history yet");
      expect(rendererText(renderer)).toContain("Check pending queue");

      await clickButton(renderer, "Recovery (0)");
      await flush();
      expect(rendererText(renderer)).toContain("No recovery records yet");
      expect(rendererText(renderer)).toContain("Recovery items appear when approvals are linked to durable runs");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("renders command and supporting evidence without requiring file targets", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "pending"
          ? [
              makeApproval({
                preview: {
                  command: "pnpm --filter @goatcitadel/mission-control test",
                  reason: "Operator requested focused coverage proof.",
                  prompt: "Run the local validation lane.",
                },
                payload: {
                  summary: "Coverage verification",
                },
              }),
            ]
          : [],
    }));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ApprovalsPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Operator evidence");
      expect(text).toContain("Commands");
      expect(text).toContain("Command: pnpm --filter @goatcitadel/mission-control test");
      expect(text).toContain("Supporting context");
      expect(text).toContain("Reason: Operator requested focused coverage proof.");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });
});
