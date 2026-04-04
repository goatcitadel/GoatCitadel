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

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const instanceText = (node: unknown): string => {
    if (typeof node === "string") {
      return node;
    }
    if (!node || typeof node !== "object" || !("children" in node)) {
      return "";
    }
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map((child) => instanceText(child)).join(" ");
  };

  const button = renderer.root.findAll((node) => (
    node.type === "button"
      && instanceText(node).replace(/\s+/g, " ").includes(label)
  ))[0];

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
    });
    apiMocks.fetchApprovals.mockResolvedValue({
      items: [
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
      ],
    });
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
    apiMocks.fetchApprovals.mockResolvedValueOnce({
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

      const text = rendererText(renderer);
      expect(text).toContain("No Pending Approvals");
      expect(text).toContain("The approvals queue is clear right now.");
      expect(text).not.toContain("Reject all pending");
      expect(text).not.toContain("0 replay trails loaded");
    } finally {
      renderer.unmount();
    }
  });

  it("prefers the replay durable run id over payload scraping when loading checkpoint status", async () => {
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
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
});
