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

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[0];

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

describe("ApprovalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
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
      expect(text).toContain("No pending approvals");
      expect(text).toContain("The approvals queue is clear right now.");
      expect(text).not.toContain("Reject all pending");
      expect(text).not.toContain("0 replay trails loaded");
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
});
