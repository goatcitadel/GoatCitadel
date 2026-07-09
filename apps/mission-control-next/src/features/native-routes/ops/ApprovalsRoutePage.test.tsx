import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ApprovalsRoutePage } from "./ApprovalsRoutePage";

const approvalHarness = vi.hoisted(() => {
  const approval = {
    approvalId: "11111111-1111-4111-8111-111111111111",
    kind: "tool.invoke",
    status: "pending",
    riskLevel: "danger",
    payload: { traceMeta: { traceId: "trace-from-payload", correlationId: "corr-from-payload" } },
    preview: {
      targets: ["workspace/file.ts"],
      commands: ["pnpm test"],
      supporting: ["Operator confirmed preconditions."],
      changes: [{ label: "Patch", content: "- old\n+ new" }],
    },
    createdAt: "2026-04-22T00:00:00.000Z",
    explanation: { summary: "Review the tool request.", riskExplanation: "Touches workspace files." },
    explanationStatus: "failed",
    explanationError:
      'chat completion failed (401 Unauthorized): {"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}',
    followUp: {
      status: "queued",
      reason: "Worker will resume when approved.",
      effectKind: "durable.resume",
      targetKind: "durable_run",
      targetId: "durable-run-42",
    },
    linkage: {
      durableRunId: "durable-run-42",
      sessionId: "session-1",
      turnId: "turn-1",
      taskId: "task-1",
      originSurface: "cowork",
      correlationId: "corr-1",
      traceId: "trace-1",
      proactiveRunId: "proactive-1",
    },
  };
  const expired = {
    ...approval,
    approvalId: "22222222-2222-4222-8222-222222222222",
    status: "approved",
    riskLevel: "nuclear",
    explanation: { summary: "Already approved." },
    explanationStatus: "completed",
    explanationError: "",
    followUp: { status: "completed", reason: "Worker resumed." },
    expiresAt: "expired",
  };
  return {
    approval,
    expired,
    overrides: {} as Record<string, unknown>,
    setView: vi.fn(),
    setSelectedApprovalId: vi.fn(),
    onResolve: vi.fn(),
    onReplay: vi.fn(),
    loadTracePreview: vi.fn(),
    loadDurableStatus: vi.fn(),
    resumeFromCheckpoint: vi.fn(),
    onRejectAllPending: vi.fn(async () => undefined),
    loadMoreVisibleApprovals: vi.fn(async () => undefined),
  };
});

function buildQueue() {
  const approval = approvalHarness.approval as any;
  const expired = approvalHarness.expired as any;
  return {
    loading: false,
    error: null,
    view: "pending",
    setView: approvalHarness.setView,
    pendingItems: [approval],
    historyItems: [expired],
    recoveryItems: [approval],
    visibleItems: [approval, expired],
    selectedApproval: approval,
    setSelectedApprovalId: approvalHarness.setSelectedApprovalId,
    replayById: {
      [approval.approvalId]: {
        approval,
        pendingAction: {
          actionId: "pending-action-1",
          request: { traceMeta: { correlationId: "corr-from-replay", traceId: "trace-from-replay" } },
        },
        events: [{ eventId: "event-1", eventType: "approval.created", actorId: "operator", timestamp: "" }],
        effects: [
          {
            effectId: "effect-replay",
            effectKind: "durable.resume",
            status: "queued",
            targetKind: "durable_run",
            targetId: "durable-run-42",
            attemptCount: 1,
            lastError: "retry later",
          },
        ],
      },
    },
    lifecycleByApprovalId: {
      [approval.approvalId]: {
        approval,
        canonical: { sessionId: "session-1", taskId: "task-1" },
        linked: { sessionIds: ["session-1", "session-2"], taskIds: ["task-1", "task-2"], runIds: ["durable-run-42"] },
        approvalWaitDurableRun: { runId: "durable-run-42", status: "paused" },
        proactiveRuns: [{ runId: "proactive-2" }],
        approvalEffects: [
          {
            effectId: "effect-1",
            effectKind: "durable.resume",
            status: "failed",
            targetKind: "durable_run",
            targetId: "durable-run-42",
            attemptCount: 2,
            lastError: "resume failed",
          },
        ],
      },
    },
    durableByApprovalId: {
      [approval.approvalId]: {
        runId: "durable-run-42",
        status: "paused",
        blockedStep: "approval",
        blockedReason: "waiting for operator",
        updatedAt: "bad-date",
      },
    },
    durableBusyByApprovalId: {},
    tracePreviewByApprovalId: { [approval.approvalId]: ["trace breadcrumb"] },
    resolvePending: false,
    replayCount: 1,
    pendingRiskCounts: { safe: 1, caution: 1, danger: 1, nuclear: 1 },
    failedStatusLanes: [],
    pendingLaneFailed: false,
    hasPendingApprovals: true,
    hasMoreVisibleApprovals: false,
    loadMorePending: false,
    bulkResolvePending: false,
    onResolve: approvalHarness.onResolve,
    onReplay: approvalHarness.onReplay,
    loadTracePreview: approvalHarness.loadTracePreview,
    loadDurableStatus: approvalHarness.loadDurableStatus,
    resumeFromCheckpoint: approvalHarness.resumeFromCheckpoint,
    onRejectAllPending: approvalHarness.onRejectAllPending,
    loadMoreVisibleApprovals: approvalHarness.loadMoreVisibleApprovals,
    summary: "Approvals stay in one operator view now.",
    ...approvalHarness.overrides,
  };
}

vi.mock("@goatcitadel/mission-control-shared/hooks/useApprovalQueue", () => ({
  useApprovalQueue: () => buildQueue(),
}));

vi.mock("@goatcitadel/mission-control-shared/content/approval-helpers", () => ({
  buildApprovalEvidenceModel: (preview: any) =>
    preview?.noEvidence
      ? null
      : {
          targets: preview?.targets ?? [],
          commands: preview?.commands ?? [],
          supporting: preview?.supporting ?? [],
          changes: preview?.changes ?? [],
        },
  findTraceMetadata: (value: any) => value?.traceMeta,
  formatInferredIds: (items: string[] = [], canonical?: string) =>
    items.filter((item) => item !== canonical).length ? items.filter((item) => item !== canonical).join(", ") : "none",
  getCanonicalDurableRunId: () => "durable-run-42",
  isExpiredApproval: (approval: any) => approval.expiresAt === "expired",
}));

function renderPage(extras: Record<string, unknown> = {}) {
  return (
    <ApprovalsRoutePage
      route={{ area: "ops", section: "approvals", theme: "ops", approvalId: "approval-route" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={1}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
      {...extras}
    />
  );
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}

function findExactButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!button) {
    throw new Error(`Missing exact button ${label}`);
  }
  return button;
}

function findLink(root: ReactTestInstance, label: string): ReactTestInstance {
  const link = root.findAll((node) => node.type === "a" && collectText(node).includes(label))[0];
  if (!link) {
    throw new Error(`Missing link ${label}`);
  }
  return link;
}

function renderText(element = renderPage()): string {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element);
  });
  const text = collectText(renderer!.root);
  act(() => {
    renderer!.unmount();
  });
  return text;
}

beforeEach(() => {
  approvalHarness.overrides = {};
  approvalHarness.setView.mockClear();
  approvalHarness.setSelectedApprovalId.mockClear();
  approvalHarness.onResolve.mockClear();
  approvalHarness.onReplay.mockClear();
  approvalHarness.loadTracePreview.mockClear();
  approvalHarness.loadDurableStatus.mockClear();
  approvalHarness.resumeFromCheckpoint.mockClear();
  approvalHarness.onRejectAllPending.mockClear();
  approvalHarness.loadMoreVisibleApprovals.mockClear();
});

describe("ApprovalsRoutePage", () => {
  it("renders the canonical queue, inspector, evidence, recovery, trace, lifecycle, and replay surfaces", () => {
    const text = renderText();

    expect(text).toContain("Approval queue");
    expect(text).toContain("Replay trail, durable recovery, and runtime linkage");
    expect(text).toContain("Review the tool request.");
    expect(text).toContain("Approval summary unavailable");
    expect(text).toContain("optional explainer could not authenticate");
    expect(text).toContain("Worker will resume when approved.");
    expect(text).toContain("workspace/file.ts");
    expect(text).toContain("trace breadcrumb");
    expect(text).toContain("Runtime linkage");
    expect(text).toContain("Approval effects");
    expect(text).toContain("Replay trail and pending action");
    expect(text).toContain("Approvals stay in one operator view now.");
  });

  it("uses shell pending counts only while the approval queue is loading or errored", () => {
    approvalHarness.overrides = {
      pendingItems: [],
      visibleItems: [],
      selectedApproval: null,
      hasPendingApprovals: false,
      loading: false,
      error: null,
    };
    const settledText = renderText(renderPage({ pendingApprovals: 3 }));

    approvalHarness.overrides = {
      pendingItems: [],
      visibleItems: [],
      selectedApproval: null,
      hasPendingApprovals: false,
      loading: false,
      error: "approval queue failed",
    };
    const errorText = renderText(renderPage({ pendingApprovals: 3 }));

    expect(settledText).toContain("Pending (0)");
    expect(settledText).not.toContain("Pending 3");
    expect(errorText).toContain("approval queue failed");
    expect(errorText).toContain("Approval queue");
    expect(errorText).toContain("Pending (3)");
    expect(errorText).toContain("Pending approvals exist, but the queue details could not be loaded.");
    expect(errorText).not.toContain("Loading current route data");
  });

  it("loads more approvals from the active queue view", async () => {
    approvalHarness.overrides = {
      hasMoreVisibleApprovals: true,
    };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(renderPage());
    });

    await act(async () => {
      findExactButton(renderer!.root, "Load more").props.onClick();
    });

    expect(approvalHarness.loadMoreVisibleApprovals).toHaveBeenCalledTimes(1);
    act(() => {
      renderer!.unmount();
    });
  });

  it("keeps the approval queue visible when an error arrives with a stale loading flag", () => {
    approvalHarness.overrides = {
      pendingItems: [],
      visibleItems: [],
      selectedApproval: null,
      hasPendingApprovals: false,
      loading: true,
      error: "approval queue failed",
    };

    const text = renderText(renderPage({ pendingApprovals: 3 }));

    expect(text).toContain("approval queue failed");
    expect(text).toContain("Approval queue");
    expect(text).toContain("Pending (3)");
    expect(text).not.toContain("Loading current route data");
  });

  it("uses the shell pending count as a floor when the pending lane failed with preserved rows", () => {
    const staleApproval = approvalHarness.approval as any;
    approvalHarness.overrides = {
      pendingItems: [staleApproval],
      visibleItems: [staleApproval],
      selectedApproval: staleApproval,
      pendingLaneFailed: true,
      failedStatusLanes: ["pending"],
      loading: false,
      error: "pending lane failed",
    };

    const text = renderText(renderPage({ pendingApprovals: 3 }));

    expect(text).toContain("Pending (3)");
    expect(text).not.toContain("Pending (1)");
  });

  it("drives view switching, queue selection, decisions, recovery, trace, live lane, and bulk rejection", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(renderPage({ navigate }));
    });

    await act(async () => {
      findButton(renderer!.root, "Pending").props.onClick();
      findButton(renderer!.root, "History").props.onClick();
      findButton(renderer!.root, "Recovery").props.onClick();
      findButton(renderer!.root, "tool.invoke").props.onClick();
      findButton(renderer!.root, "Approve now").props.onClick();
      findButton(renderer!.root, "Load replay trail").props.onClick();
      findButton(renderer!.root, "Load durable status").props.onClick();
      findButton(renderer!.root, "Refresh trace detail").props.onClick();
    });
    expect(approvalHarness.onResolve).not.toHaveBeenCalled();
    let modal = renderer!.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);
    expect(modal.props.title).toBe("Approve this request?");
    expect(modal.props.danger).toBe(false);
    await act(async () => {
      await modal.props.onConfirm();
    });

    await act(async () => {
      findExactButton(renderer!.root, "Reject").props.onClick();
    });
    modal = renderer!.root.findByType(ConfirmModal);
    expect(modal.props.title).toBe("Reject this request?");
    expect(modal.props.danger).toBe(true);
    await act(async () => {
      await modal.props.onConfirm();
    });

    expect(approvalHarness.resumeFromCheckpoint).not.toHaveBeenCalled();
    await act(async () => {
      findButton(renderer!.root, "Resume paused run").props.onClick();
    });
    modal = renderer!.root.findByType(ConfirmModal);
    expect(modal.props.title).toBe("Resume paused run?");
    expect(modal.props.danger).toBe(false);
    await act(async () => {
      await modal.props.onConfirm();
    });

    expect(approvalHarness.setView).toHaveBeenCalledWith("pending");
    expect(approvalHarness.setView).toHaveBeenCalledWith("history");
    expect(approvalHarness.setView).toHaveBeenCalledWith("recovery");
    expect(approvalHarness.setSelectedApprovalId).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(approvalHarness.onResolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "approve");
    expect(approvalHarness.onResolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "reject");
    expect(approvalHarness.onReplay).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(approvalHarness.loadDurableStatus).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(approvalHarness.resumeFromCheckpoint).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(approvalHarness.loadTracePreview).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "corr-1");

    const liveLink = findLink(renderer!.root, "Open live session");
    expect(liveLink.props.href).toBe(
      "/chat?sessionId=session-1&turnId=turn-1&approvalId=11111111-1111-4111-8111-111111111111",
    );
    await act(async () => {
      liveLink.props.onClick({ preventDefault: vi.fn() });
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "11111111-1111-4111-8111-111111111111",
    });
    navigate.mockClear();
    const preventModifiedClickDefault = vi.fn();
    await act(async () => {
      liveLink.props.onClick({
        preventDefault: preventModifiedClickDefault,
        ctrlKey: true,
        button: 0,
        currentTarget: { target: "" },
      });
    });
    expect(preventModifiedClickDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      findButton(renderer!.root, "Reject all pending").props.onClick();
    });
    modal = renderer!.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);
    expect(modal.props.danger).toBe(true);
    await act(async () => {
      modal.props.onCancel();
    });
    expect(renderer!.root.findByType(ConfirmModal).props.open).toBe(false);

    await act(async () => {
      findButton(renderer!.root, "Reject all pending").props.onClick();
    });
    await act(async () => {
      await renderer!.root.findByType(ConfirmModal).props.onConfirm();
    });
    expect(approvalHarness.onRejectAllPending).toHaveBeenCalledTimes(1);
  });

  it("routes Code Mode approvals back to Chat when origin linkage is present", async () => {
    const navigate = vi.fn();
    approvalHarness.overrides = {
      selectedApproval: {
        ...(approvalHarness.approval as any),
        kind: "code_mode.run",
        linkage: {
          ...(approvalHarness.approval as any).linkage,
          originSurface: "code",
        },
      },
    };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(renderPage({ navigate }));
    });

    await act(async () => {
      findLink(renderer!.root, "Open live session").props.onClick({ preventDefault: vi.fn() });
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("routes Code Mode approvals back to Chat when origin surface is missing", async () => {
    const navigate = vi.fn();
    approvalHarness.overrides = {
      selectedApproval: {
        ...(approvalHarness.approval as any),
        kind: "code_mode.run",
        linkage: {
          ...(approvalHarness.approval as any).linkage,
          originSurface: undefined,
        },
      },
    };
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(renderPage({ navigate }));
    });

    await act(async () => {
      findLink(renderer!.root, "Open live session").props.onClick({ preventDefault: vi.fn() });
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("renders empty, loading, error, busy, and alternate explainer states", () => {
    approvalHarness.overrides = {
      visibleItems: [],
      selectedApproval: null,
      pendingItems: [],
      historyItems: [],
      recoveryItems: [],
      hasPendingApprovals: false,
      bulkResolvePending: true,
      loading: true,
      error: "approval queue failed",
      summary: "",
    };
    let text = renderText();
    expect(text).toContain("approval queue failed");

    approvalHarness.overrides = {
      visibleItems: [],
      selectedApproval: null,
      pendingItems: [],
      historyItems: [],
      recoveryItems: [],
      hasPendingApprovals: false,
      bulkResolvePending: true,
      loading: false,
      error: null,
      summary: "",
    };
    text = renderText();
    expect(text).toContain("No approvals in this view.");
    expect(text).toContain("Select a queue item");
    expect(text).toContain("Rejecting...");

    approvalHarness.overrides = {
      selectedApproval: {
        ...(approvalHarness.approval as any),
        explanationError: "unsupported parameter: temperature",
        followUp: { status: "failed", effectKind: "durable.resume", targetKind: "run", targetId: "run-1" },
        linkage: {},
      },
      replayById: {},
      lifecycleByApprovalId: {},
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };
    text = renderText();
    expect(text).toContain("parameter this model provider does not accept");
    expect(text).toContain("Wake failed");
    expect(text).not.toContain("Open live session");

    approvalHarness.overrides = {
      selectedApproval: {
        ...(approvalHarness.approval as any),
        explanationError: "provider timed out",
        followUp: { status: "skipped", effectKind: "noop", targetKind: "run", targetId: "run-2" },
      },
      durableByApprovalId: { [(approvalHarness.approval as any).approvalId]: { runId: "run-2", status: "running" } },
      durableBusyByApprovalId: { [(approvalHarness.approval as any).approvalId]: true },
    };
    text = renderText();
    expect(text).toContain("Explainer detail: provider timed out");
    expect(text).toContain("Wake skipped");
    expect(text).toContain("Loading...");
  });

  it("requires durable status inspection before resuming a paused approval run", async () => {
    approvalHarness.overrides = {
      durableByApprovalId: {},
      durableBusyByApprovalId: {},
    };

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(renderPage());
    });

    const resumeButton = findButton(renderer!.root, "Resume paused run");
    expect(resumeButton.props.disabled).toBe(true);
  });

  it("renders alternate approval states, metadata fallbacks, and optional inspector sections", async () => {
    const navigate = vi.fn();
    const base = approvalHarness.approval as any;
    const approved = {
      ...base,
      approvalId: "approval-approved",
      kind: "safe.operation",
      status: "approved",
      riskLevel: "safe",
      explanationStatus: "pending",
      explanationError: "   ",
      followUp: {
        status: "running",
        effectKind: "durable.resume",
        targetKind: "run",
        targetId: "run-7",
      },
      linkage: {
        sessionId: "session-chat",
        turnId: "turn-chat",
        originSurface: "email",
      },
    };
    const rejected = {
      ...base,
      approvalId: "approval-rejected",
      kind: "caution.operation",
      status: "rejected",
      riskLevel: "caution",
      explanationStatus: "completed",
      explanationError: "",
      explanation: null,
      resolutionNote: "Rejected after review.",
      followUp: null,
      linkage: {},
      preview: { noEvidence: true },
      payload: {},
    };
    approvalHarness.overrides = {
      view: "history",
      visibleItems: [approved, rejected],
      selectedApproval: approved,
      replayById: {
        [approved.approvalId]: {
          approval: {
            ...approved,
            linkage: { correlationId: "corr-from-replay-approval", traceId: "trace-from-replay-approval" },
          },
          pendingAction: null,
          events: [],
          effects: [],
        },
      },
      lifecycleByApprovalId: {
        [approved.approvalId]: {
          approval: approved,
          canonical: null,
          linked: { sessionIds: [], taskIds: [], runIds: [] },
          approvalEffects: [],
        },
      },
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(renderPage({ navigate }));
    });
    let text = collectText(renderer!.root);
    expect(text).toContain("approved");
    expect(text).toContain("rejected");
    expect(text).toContain("safe");
    expect(text).toContain("caution");
    expect(text).toContain("Decision recorded");
    expect(text).not.toContain("Human decision required");
    expect(text).toContain("Approval summary unavailable");
    expect(text).toContain("optional plain-English summary");
    expect(text).toContain("Worker wake running");
    expect(text).not.toContain("Reject all pending");
    expect(text).not.toContain("Approve now");

    const liveLink = findLink(renderer!.root, "Open live session");
    expect(liveLink.props.href).toBe("/chat?sessionId=session-chat&turnId=turn-chat&approvalId=approval-approved");
    await act(async () => {
      liveLink.props.onClick({ preventDefault: vi.fn() });
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      sessionId: "session-chat",
      turnId: "turn-chat",
      approvalId: "approval-approved",
    });

    await act(async () => {
      findButton(renderer!.root, "Load trace detail").props.onClick();
    });
    expect(approvalHarness.loadTracePreview).toHaveBeenCalledWith("approval-approved", "corr-from-replay-approval");

    approvalHarness.overrides = {
      view: "pending",
      visibleItems: [rejected],
      selectedApproval: rejected,
      replayById: {},
      lifecycleByApprovalId: {},
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };
    text = renderText();
    expect(text).toContain("Rejected after review.");
    expect(text).not.toContain("Operator evidence");

    approvalHarness.overrides = {
      selectedApproval: {
        ...base,
        approvalId: "approval-weird-follow-up",
        status: "pending",
        riskLevel: "danger",
        explanationStatus: "unknown",
        explanationError: "",
        followUp: { status: "mystery" },
        linkage: {},
        payload: { traceMeta: { correlationId: "corr-from-payload-only", traceId: "trace-from-payload-only" } },
        preview: {},
      },
      replayById: {},
      lifecycleByApprovalId: {},
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };
    text = renderText();
    expect(text).toContain("Follow-up status unknown");
    expect(text).toContain("unknown");

    approvalHarness.overrides = {
      selectedApproval: {
        ...base,
        approvalId: "approval-trace-without-correlation",
        explanationError: "",
        linkage: {},
        payload: { traceMeta: { traceId: "trace-only" } },
        preview: {},
      },
      replayById: {},
      lifecycleByApprovalId: {},
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };
    text = renderText();
    expect(text).toContain("trace-only");
    expect(text).not.toContain("Load trace detail");

    approvalHarness.overrides = {
      selectedApproval: {
        ...base,
        approvalId: "approval-expired",
        status: "pending",
        riskLevel: "nuclear",
        explanationStatus: undefined,
        explanationError: "",
        followUp: { status: "none" },
        expiresAt: "expired",
      },
      replayById: {},
      lifecycleByApprovalId: {},
      durableByApprovalId: {},
      tracePreviewByApprovalId: {},
    };
    text = renderText();
    expect(text).toContain("expired");
    expect(text).toContain("Approval expired");
    expect(text).not.toContain("No follow-up");
  });
});
