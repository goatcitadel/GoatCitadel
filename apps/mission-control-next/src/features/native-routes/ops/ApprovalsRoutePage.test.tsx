import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalsRoutePage } from "./ApprovalsRoutePage";

vi.mock("@goatcitadel/mission-control-shared/hooks/useApprovalQueue", () => ({
  useApprovalQueue: () => ({
    loading: false,
    error: null,
    view: "pending",
    setView: vi.fn(),
    pendingItems: [
      {
        approvalId: "11111111-1111-4111-8111-111111111111",
        kind: "tool.invoke",
        status: "pending",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: "2026-04-22T00:00:00.000Z",
        explanation: { summary: "Review the tool request." },
        explanationError:
          'chat completion failed (401 Unauthorized): {"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}',
        linkage: { durableRunId: "durable-run-42", sessionId: "session-1" },
      },
    ],
    historyItems: [],
    recoveryItems: [],
    visibleItems: [
      {
        approvalId: "11111111-1111-4111-8111-111111111111",
        kind: "tool.invoke",
        status: "pending",
        riskLevel: "danger",
        payload: {},
        preview: {},
        createdAt: "2026-04-22T00:00:00.000Z",
        explanation: { summary: "Review the tool request." },
        explanationError:
          'chat completion failed (401 Unauthorized): {"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}',
        linkage: { durableRunId: "durable-run-42", sessionId: "session-1" },
      },
    ],
    selectedApproval: {
      approvalId: "11111111-1111-4111-8111-111111111111",
      kind: "tool.invoke",
      status: "pending",
      riskLevel: "danger",
      payload: {},
      preview: {},
      createdAt: "2026-04-22T00:00:00.000Z",
      explanation: { summary: "Review the tool request." },
      explanationError:
        'chat completion failed (401 Unauthorized): {"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}',
      linkage: { durableRunId: "durable-run-42", sessionId: "session-1" },
    },
    setSelectedApprovalId: vi.fn(),
    replayById: {},
    lifecycleByApprovalId: {},
    durableByApprovalId: {},
    durableBusyByApprovalId: {},
    tracePreviewByApprovalId: {},
    resolvePending: false,
    replayCount: 1,
    pendingRiskCounts: { safe: 0, caution: 0, danger: 1, nuclear: 0 },
    hasPendingApprovals: true,
    bulkResolvePending: false,
    onResolve: vi.fn(),
    onReplay: vi.fn(),
    loadTracePreview: vi.fn(),
    loadDurableStatus: vi.fn(),
    resumeFromCheckpoint: vi.fn(),
    onRejectAllPending: vi.fn(async () => undefined),
    summary: "Approvals stay in the canonical next shell now.",
  }),
}));

vi.mock("@goatcitadel/mission-control-shared/content/approval-helpers", () => ({
  buildApprovalEvidenceModel: () => ({
    targets: ["workspace/file.ts"],
    commands: ["pnpm test"],
    supporting: ["Operator confirmed preconditions."],
    changes: [],
  }),
  findTraceMetadata: () => undefined,
  formatInferredIds: (items: string[] = []) => (items.length ? items.join(", ") : "none"),
  getCanonicalDurableRunId: () => "durable-run-42",
  isExpiredApproval: () => false,
}));

describe("ApprovalsRoutePage", () => {
  it("renders the canonical queue and inspector surfaces", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsRoutePage
        route={{ area: "ops", section: "approvals", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={1}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Approval queue");
    expect(markup).toContain("Replay trail, durable recovery, and runtime linkage");
    expect(markup).toContain("Review the tool request.");
    expect(markup).toContain("Approval summary unavailable");
    expect(markup).toContain("optional explainer could not authenticate");
    expect(markup).toContain("Approvals stay in the canonical next shell now.");
  });
});
