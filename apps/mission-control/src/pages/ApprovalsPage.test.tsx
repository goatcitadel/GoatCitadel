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

vi.mock("../api/client", () => ({
  fetchApprovals: apiMocks.fetchApprovals,
  fetchApprovalReplay: apiMocks.fetchApprovalReplay,
  fetchDevDiagnostics: apiMocks.fetchDevDiagnostics,
  fetchDurableRun: apiMocks.fetchDurableRun,
  fetchDurableRunTimeline: apiMocks.fetchDurableRunTimeline,
  fetchRuntimeLifecycle: apiMocks.fetchRuntimeLifecycle,
  resolveApproval: apiMocks.resolveApproval,
  resolveApprovalsBulk: apiMocks.resolveApprovalsBulk,
  resumeDurableRun: apiMocks.resumeDurableRun,
}));
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

import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
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

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  await act(async () => {
    button.props.onClick();
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
    approvalId: "approval-1",
    kind: "shell.exec",
    riskLevel: "danger",
    status: "pending",
    preview: {
      toolName: "shell.exec",
      sessionId: "sess-1",
    },
    payload: {
      toolName: "shell.exec",
      sessionId: "sess-1",
    },
    explanationStatus: "not_requested",
    explanation: null,
    explanationError: null,
    createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function mockApprovalStatuses(statuses: Record<string, unknown[]>) {
  apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
    items: statuses[status ?? "pending"] ?? [],
  }));
}

describe("ApprovalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: {
        search: "",
      },
    });
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "pending"
          ? [
              {
                approvalId: "approval-1",
                kind: "shell.exec",
                riskLevel: "danger",
                status: "pending",
                preview: {
                  toolName: "shell.exec",
                  sessionId: "sess-1",
                },
                payload: {
                  toolName: "shell.exec",
                  sessionId: "sess-1",
                },
                explanationStatus: "not_requested",
                explanation: null,
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
              },
            ]
          : [],
    }));
  });

  it("keeps the bulk reject action visible when rendered inside shell chrome", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("1 pending");
      expect(text).toContain("Reject all pending");
      expect(text).toContain("Approve");
      expect(text).toContain("Reject");
    } finally {
      renderer.unmount();
    }
  });

  it("switches to a clean empty state when no pending approvals remain", async () => {
    apiMocks.fetchApprovals.mockImplementation(async () => ({ items: [] }));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      const text = rendererText(renderer);
      const tree = JSON.stringify(renderer.toJSON());
      expect(text).toContain("No pending approvals");
      expect(text).toContain("The approvals queue is clear right now.");
      expect(text).toContain("Review history");
      expect(text).not.toContain("Reject all pending");
      expect(text).not.toContain("0 replay trails loaded");
      expect(tree).toContain("status-chip-success");
      expect(tree).not.toContain("status-chip-warning");
    } finally {
      renderer.unmount();
    }
  });

  it("prefers the replay durable run id over payload scraping when loading checkpoint status", async () => {
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-1",
        runId: "durable-run-42",
      },
      query: {
        approvalId: "approval-1",
        runId: "durable-run-42",
      },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: ["durable-run-42"],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-run-42",
      status: "waiting",
      updatedAt: new Date("2026-03-29T18:05:00.000Z").toISOString(),
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();
      await clickButton(renderer, "Load durable status");
      await flush();

      const text = rendererText(renderer);
      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith({ approvalId: "approval-1" });
      expect(apiMocks.fetchDurableRun).toHaveBeenCalledWith("durable-run-42");
      expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledWith("durable-run-42", 120);
      expect(text).toContain("Run: durable-run-42 | Status: waiting");
    } finally {
      renderer.unmount();
    }
  });

  it("does not render historical blocker details when the current durable run is no longer blocked", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "approved"
          ? [
              {
                approvalId: "approval-recovery",
                kind: "shell.exec",
                riskLevel: "danger",
                status: "approved",
                preview: {},
                payload: {},
                linkage: {
                  durableRunId: "durable-run-42",
                },
                explanationStatus: "not_requested",
                explanation: null,
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:10:00.000Z").toISOString(),
              },
            ]
          : [],
    }));
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-recovery",
        runId: "durable-run-42",
      },
      query: {
        approvalId: "approval-recovery",
        runId: "durable-run-42",
      },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: ["durable-run-42"],
        proactiveRunIds: [],
        approvalIds: ["approval-recovery"],
        taskIds: [],
        workspaceIds: [],
      },
      durableRun: {
        runId: "durable-run-42",
        status: "completed",
        updatedAt: new Date("2026-03-29T18:20:00.000Z").toISOString(),
      },
      turns: [],
      toolRuns: [],
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventId: "timeline-1",
          eventType: "run_waiting",
          stepKey: "checkpoint-step",
          payload: {
            stepKey: "checkpoint-step",
            reason: "Waiting for approval",
          },
          timestamp: new Date("2026-03-29T18:05:00.000Z").toISOString(),
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Recovery (1)");
      await flush();
      await clickButton(renderer, "Load durable status");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Run: durable-run-42 | Status: completed");
      expect(text).not.toContain("Blocked step:");
      expect(text).not.toContain("Waiting for approval");
    } finally {
      renderer.unmount();
    }
  });

  it("auto-loads durable status when resuming without a prior manual load", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "approved"
          ? [
              {
                approvalId: "approval-recovery",
                kind: "shell.exec",
                riskLevel: "danger",
                status: "approved",
                preview: {},
                payload: {},
                linkage: {
                  durableRunId: "durable-run-77",
                },
                explanationStatus: "not_requested",
                explanation: null,
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:10:00.000Z").toISOString(),
              },
            ]
          : [],
    }));
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-recovery",
        runId: "durable-run-77",
      },
      query: {
        approvalId: "approval-recovery",
        runId: "durable-run-77",
      },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: ["durable-run-77"],
        proactiveRunIds: [],
        approvalIds: ["approval-recovery"],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-run-77",
      status: "paused",
      updatedAt: new Date("2026-03-29T18:05:00.000Z").toISOString(),
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventId: "timeline-2",
          eventType: "run_paused",
          stepKey: "checkpoint-step",
          payload: {
            stepKey: "checkpoint-step",
            reason: "Paused for operator review",
          },
          timestamp: new Date("2026-03-29T18:04:00.000Z").toISOString(),
        },
      ],
    });
    apiMocks.resumeDurableRun.mockResolvedValue({
      runId: "durable-run-77",
      status: "running",
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Recovery (1)");
      await flush();

      const resumeButton = renderer.root.findAll(
        (node) => node.type === "button" && instanceText(node).includes("Resume paused run"),
      )[0];
      expect(resumeButton?.props.disabled).toBe(false);

      await act(async () => {
        resumeButton?.props.onClick();
      });
      await flush();
      const confirmResumeModal = renderer.root.findAll(
        (node) =>
          typeof node.type === "function" && node.props?.open === true && node.props?.title === "Resume Durable Run",
      )[0];
      await act(async () => {
        confirmResumeModal?.props.onConfirm();
      });
      await flush();

      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith({ approvalId: "approval-recovery" });
      expect(apiMocks.resumeDurableRun).toHaveBeenCalledWith("durable-run-77", "operator");
      expect(rendererText(renderer)).not.toContain(
        "Load durable status first so we can resume from the exact checkpoint.",
      );
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces inline operator evidence for code-heavy approvals before the raw payload", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "pending"
          ? [
              {
                approvalId: "approval-code",
                kind: "files.apply_patch",
                riskLevel: "danger",
                status: "pending",
                preview: {
                  files: ["apps/mission-control/src/pages/ChatPage.tsx"],
                  patch:
                    "*** Begin Patch\n*** Update File: apps/mission-control/src/pages/ChatPage.tsx\n+const nextValue = true;\n*** End Patch",
                },
                payload: {
                  command: "apply patch to ChatPage",
                },
                explanationStatus: "completed",
                explanation: {
                  summary: "Apply a patch to the Chat page.",
                  riskExplanation: "This changes production UI code.",
                  saferAlternative: "Review the patch before approving.",
                  generatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                },
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
              },
            ]
          : [],
    }));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Operator evidence");
      expect(text).toContain("Files: apps/mission-control/src/pages/ChatPage.tsx");
      expect(text).toContain("Patch");
      expect(text).toContain("Raw request and preview payload");
      expect(text).toContain("Raw request payload");
      expect(text).toContain("Preview payload");
    } finally {
      renderer.unmount();
    }
  });

  it("opens the matching live lane for persisted approvals that came from code", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "pending"
          ? [
              {
                approvalId: "approval-code-lane",
                kind: "shell.exec",
                riskLevel: "danger",
                status: "pending",
                preview: {
                  toolName: "shell.exec",
                  sessionId: "sess-code",
                },
                payload: {
                  toolName: "shell.exec",
                  sessionId: "sess-code",
                },
                linkage: {
                  sessionId: "sess-code",
                  turnId: "turn-code",
                  originSurface: "code",
                },
                explanationStatus: "not_requested",
                explanation: null,
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
              },
            ]
          : [],
    }));

    let renderer = create(<div />);
    const originalHistory = window.history;
    const originalDispatchEvent = window.dispatchEvent;
    const pushStateSpy = vi.fn();
    const dispatchEventSpy = vi.fn();
    Object.defineProperty(window, "history", {
      configurable: true,
      value: {
        ...originalHistory,
        pushState: pushStateSpy,
      },
    });
    Object.defineProperty(window, "dispatchEvent", {
      configurable: true,
      value: dispatchEventSpy,
    });
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      const liveLaneLink = renderer.root.findAll(
        (node) =>
          node.type === "a" &&
          typeof node.props.href === "string" &&
          node.props.href.includes("surface=code") &&
          node.props.href.includes("sessionId=sess-code") &&
          node.props.href.includes("turnId=turn-code"),
      )[0];

      expect(liveLaneLink).toBeTruthy();
      const preventDefault = vi.fn();

      await act(async () => {
        liveLaneLink?.props.onClick?.({ preventDefault });
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(pushStateSpy).toHaveBeenCalledWith(null, "", expect.stringContaining("surface=code"));
      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "popstate" }));
    } finally {
      Object.defineProperty(window, "history", {
        configurable: true,
        value: originalHistory,
      });
      Object.defineProperty(window, "dispatchEvent", {
        configurable: true,
        value: originalDispatchEvent,
      });
      renderer.unmount();
    }
  });

  it("moves expired pending approvals into history instead of leaving them in the pending queue", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => ({
      items:
        status === "pending"
          ? [
              {
                approvalId: "approval-expired",
                kind: "shell.exec",
                riskLevel: "danger",
                status: "pending",
                preview: {},
                payload: {},
                expiresAt: new Date("2026-03-01T00:00:00.000Z").toISOString(),
                explanationStatus: "not_requested",
                explanation: null,
                explanationError: null,
                createdAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-03-29T18:00:00.000Z").toISOString(),
              },
            ]
          : [],
    }));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      let text = rendererText(renderer);
      expect(text).toContain("Pending (0)");
      expect(text).toContain("History (1)");

      await clickButton(renderer, "History (1)");
      await flush();

      text = rendererText(renderer);
      expect(text).toContain("expired");
      expect(text).not.toContain("Approve now");
    } finally {
      renderer.unmount();
    }
  });

  it("renders canonical approval linkage separately from inferred and wait-mapped runs", async () => {
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-1",
        sessionId: "session-canonical",
        taskId: "task-canonical",
        runId: "run-canonical",
      },
      query: {
        approvalId: "approval-1",
        sessionId: "session-canonical",
        taskId: "task-canonical",
        runId: "run-canonical",
      },
      linked: {
        sessionIds: ["session-canonical", "session-inferred"],
        turnIds: [],
        runIds: ["run-canonical", "run-inferred", "run-wait"],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: ["task-canonical", "task-inferred"],
        workspaceIds: [],
      },
      approvalWaitDurableRun: {
        runId: "run-wait",
        status: "waiting",
        updatedAt: new Date("2026-03-29T18:05:00.000Z").toISOString(),
      },
      turns: [],
      toolRuns: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();
      await clickButton(renderer, "Load durable status");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Canonical run: run-canonical");
      expect(text).toContain("Inferred runs: run-inferred, run-wait");
      expect(text).toContain("Wait mapping: run-wait | Status: waiting");
      expect(text).toContain("Canonical session: session-canonical");
      expect(text).toContain("Canonical task: task-canonical");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the resolve modal open and surfaces the error when approval resolution fails", async () => {
    apiMocks.resolveApproval.mockRejectedValueOnce(new Error("network down"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Approve now");
      await flush();
      await clickButton(renderer, "Approve", 1);
      await flush();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const text = rendererText(renderer);
      expect(apiMocks.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
      expect(text).toContain("Approve Action");
      expect(text).toContain("network down");
    } finally {
      renderer.unmount();
    }
  });

  it("resolves a pending approval, applies replay metadata, and moves the record into history", async () => {
    const approved = makeApproval({
      status: "approved",
      resolvedAt: "2026-03-29T18:10:00.000Z",
      linkage: {
        durableRunId: "durable-run-approve",
        sessionId: "sess-1",
        taskId: "task-1",
      },
    });
    apiMocks.resolveApproval.mockResolvedValueOnce({
      approval: approved,
      replay: {
        approval: approved,
        events: [
          {
            eventId: "replay-1",
            eventType: "approval_resolved",
            timestamp: "2026-03-29T18:10:00.000Z",
          },
        ],
        effects: [
          {
            effectId: "effect-1",
            effectKind: "resume_durable_run",
            targetKind: "durable_run",
            targetId: "durable-run-approve",
            status: "queued",
            attemptCount: 0,
          },
        ],
      },
      effects: [
        {
          effectId: "effect-1",
          effectKind: "resume_durable_run",
          targetKind: "durable_run",
          targetId: "durable-run-approve",
          status: "queued",
          attemptCount: 0,
        },
      ],
      durableRunId: "durable-run-approve",
      executedAction: {
        outcome: "executed",
        policyReason: "operator approved",
      },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Approve now");
      await flush();
      await clickButton(renderer, "Approve", 1);
      await flush();

      let text = rendererText(renderer);
      expect(apiMocks.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
      expect(text).toContain("Approval approval-1 resolved and action executed: operator approved");
      expect(text).toContain("No pending approvals");

      await clickButton(renderer, "History (1)");
      await flush();

      text = rendererText(renderer);
      expect(text).toContain("approved");
      expect(text).toContain("Run: durable-run-approve | Status: approved");
      expect(text).toContain("Approval effects");
      expect(text).toContain("resume_durable_run");
    } finally {
      renderer.unmount();
    }
  });

  it("bulk rejects pending approvals through the confirmation path and refreshes the queue", async () => {
    let pendingFetches = 0;
    apiMocks.fetchApprovals.mockImplementation(async (status?: string) => {
      if (status === "pending") {
        pendingFetches += 1;
        return { items: pendingFetches === 1 ? [makeApproval()] : [] };
      }
      return { items: [] };
    });
    apiMocks.resolveApprovalsBulk.mockResolvedValueOnce({
      decision: "reject",
      resolvedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      approvals: [],
      failures: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Reject all pending");
      await flush();
      expect(rendererText(renderer)).toContain("Reject All Pending Approvals");

      await clickButton(renderer, "Reject all pending", 1);
      await flush();

      expect(apiMocks.resolveApprovalsBulk).toHaveBeenCalledWith({
        decision: "reject",
        status: "pending",
        resolutionNote: "Bulk rejected from the approvals queue.",
      });
      expect(rendererText(renderer)).toContain("Rejected 1 pending approvals. Skipped 0. Failed 0.");
      expect(rendererText(renderer)).toContain("No pending approvals");
    } finally {
      renderer.unmount();
    }
  });

  it("loads a trace preview from approval correlation metadata", async () => {
    mockApprovalStatuses({
      pending: [
        makeApproval({
          approvalId: "approval-trace",
          linkage: {
            correlationId: "corr-approval-1",
            traceId: "trace-approval-1",
          },
        }),
      ],
    });
    apiMocks.fetchDevDiagnostics.mockResolvedValueOnce({
      items: [
        {
          timestamp: "2026-03-29T18:02:00.000Z",
          event: "approval.trace",
          message: "Trace lane captured the pending tool call.",
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      expect(rendererText(renderer)).toContain("trace: trace-approval-1");
      await clickButton(renderer, "Load trace detail");
      await flush();

      expect(apiMocks.fetchDevDiagnostics).toHaveBeenCalledWith({
        correlationId: "corr-approval-1",
        limit: 12,
      });
      expect(rendererText(renderer)).toContain("Trace lane captured the pending tool call.");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces replay, durable lookup, resume, and bulk-resolution failures", async () => {
    apiMocks.fetchApprovalReplay.mockRejectedValueOnce(new Error("replay unavailable"));
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-1",
      },
      query: {
        approvalId: "approval-1",
      },
      linked: {
        sessionIds: [],
        turnIds: [],
        runIds: [],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [],
    });
    apiMocks.resolveApprovalsBulk.mockRejectedValueOnce(new Error("bulk reject failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Load replay trail");
      await flush();
      expect(rendererText(renderer)).toContain("replay unavailable");

      await clickButton(renderer, "Load durable status");
      await flush();
      expect(rendererText(renderer)).toContain("No canonical durable run is linked to this approval yet.");

      await clickButton(renderer, "Resume paused run");
      await flush();
      await clickButton(renderer, "Resume");
      await flush();
      expect(apiMocks.resumeDurableRun).not.toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("No canonical durable run is linked to this approval yet.");

      await clickButton(renderer, "Reject all pending");
      await flush();
      await clickButton(renderer, "Reject all pending", 1);
      await flush();
      expect(rendererText(renderer)).toContain("bulk reject failed");
    } finally {
      renderer.unmount();
    }
  });

  it("summarizes queued follow-on effects when resolution does not execute immediately", async () => {
    const rejected = makeApproval({
      status: "rejected",
      resolvedAt: "2026-03-29T18:11:00.000Z",
    });
    apiMocks.resolveApproval.mockResolvedValueOnce({
      approval: rejected,
      replay: {
        approval: rejected,
        events: [],
        effects: [],
      },
      effects: [
        {
          effectId: "effect-queued-1",
          effectKind: "notify_operator",
          targetKind: "approval",
          targetId: "approval-1",
          status: "queued",
          attemptCount: 0,
        },
        {
          effectId: "effect-queued-2",
          effectKind: "refresh_dashboard",
          targetKind: "dashboard",
          targetId: "shell",
          status: "queued",
          attemptCount: 0,
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Reject", 1);
      await flush();
      await clickButton(renderer, "Reject", 2);
      await flush();

      expect(apiMocks.resolveApproval).toHaveBeenCalledWith("approval-1", "reject");
      expect(rendererText(renderer)).toContain("Approval approval-1 resolved. 2 follow-on effects queued.");
    } finally {
      renderer.unmount();
    }
  });

  it("renders rich recovery lineage and explanation error states", async () => {
    mockApprovalStatuses({
      approved: [
        makeApproval({
          approvalId: "approval-recovery-rich",
          kind: "browser.use",
          status: "approved",
          riskLevel: "nuclear",
          explanationStatus: "failed",
          explanationError: "explainer timed out",
          linkage: {
            durableRunId: "run-rich",
            sessionId: "session-rich",
            taskId: "task-rich",
            proactiveRunId: "proactive-link",
            originSurface: "cowork",
            externalReferenceRoots: [{ label: "Research Vault", access: "read" }],
          },
        }),
      ],
    });
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: {
        approvalId: "approval-recovery-rich",
        sessionId: "session-rich",
        taskId: "task-rich",
        runId: "run-rich",
      },
      query: {
        approvalId: "approval-recovery-rich",
        runId: "run-rich",
      },
      linked: {
        sessionIds: ["session-rich", "session-inferred"],
        turnIds: [],
        runIds: ["run-rich", "run-inferred"],
        proactiveRunIds: ["proactive-link"],
        approvalIds: ["approval-recovery-rich"],
        taskIds: ["task-rich", "task-inferred"],
        workspaceIds: ["workspace-rich"],
      },
      approval: {
        linkage: {
          sessionId: "session-rich",
          taskId: "task-rich",
          durableRunId: "run-rich",
        },
      },
      durableRun: {
        runId: "run-rich",
        status: "paused",
        updatedAt: "2026-03-29T18:20:00.000Z",
      },
      resolution: {
        sessionIdSource: "canonical",
        turnIdSource: "inferred",
        runIdSource: "canonical",
        taskIdSource: "canonical",
      },
      executionPlans: [
        {
          planId: "plan-rich",
          status: "active",
          objective: "Resume the browser workflow",
        },
      ],
      delegationRuns: [{ runId: "delegation-run-1" }],
      delegationSteps: [
        {
          stepId: "delegation-step-1",
          role: "Researcher",
          status: "completed",
          durableRunId: "child-run",
          childSessionId: "child-session",
          childTurnId: "child-turn",
        },
      ],
      proactiveRuns: [
        {
          runId: "proactive-link",
          status: "waiting",
          originSurface: "cowork",
          linkedDurableRunId: "run-rich",
          nextWakeAt: "2026-03-29T19:00:00.000Z",
          stopReason: "approval_required",
        },
      ],
      approvalEffects: [
        {
          effectId: "effect-rich",
          effectKind: "resume_durable_run",
          targetKind: "durable_run",
          targetId: "run-rich",
          status: "queued",
          attemptCount: 2,
          lastError: "worker busy",
        },
      ],
      turns: [],
      toolRuns: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Recovery (1)");
      await flush();
      await clickButton(renderer, "Load durable status");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Explanation failed");
      expect(text).toContain("Explainer error: explainer timed out");
      expect(text).toContain("nuclear risk");
      expect(text).toContain("Provenance: session canonical");
      expect(text).toContain("Proactive run: proactive-link");
      expect(text).toContain("Reference roots: Research Vault (read)");
      expect(text).toContain("Execution plans: 1 | Delegation runs: 1 | Delegation steps: 1");
      expect(text).toContain("Resume the browser workflow");
      expect(text).toContain("Researcher");
      expect(text).toContain("attempts 2 | error worker busy");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps operator cancel paths local for resolve, resume, and bulk modals", async () => {
    mockApprovalStatuses({
      approved: [
        makeApproval({
          approvalId: "approval-recovery-cancel",
          status: "approved",
          linkage: {
            durableRunId: "run-cancel",
          },
        }),
      ],
      pending: [makeApproval()],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <EmbeddedPageChromeProvider>
            <ApprovalsPage />
          </EmbeddedPageChromeProvider>,
        );
      });
      await flush();

      await clickButton(renderer, "Approve now");
      await flush();
      await clickButton(renderer, "Cancel");
      await flush();
      expect(rendererText(renderer)).not.toContain("Approve Action");
      expect(apiMocks.resolveApproval).not.toHaveBeenCalled();

      await clickButton(renderer, "Recovery (1)");
      await flush();
      await clickButton(renderer, "Resume paused run");
      await flush();
      expect(rendererText(renderer)).toContain("Resume Durable Run");
      await clickButton(renderer, "Cancel");
      await flush();
      expect(apiMocks.resumeDurableRun).not.toHaveBeenCalled();

      await clickButton(renderer, "Pending (1)");
      await flush();
      await clickButton(renderer, "Reject all pending");
      await flush();
      expect(rendererText(renderer)).toContain("Reject All Pending Approvals");
      await clickButton(renderer, "Cancel");
      await flush();
      expect(apiMocks.resolveApprovalsBulk).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });
});
