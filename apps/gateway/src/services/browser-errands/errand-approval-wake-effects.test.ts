import type { ApprovalRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import { ApprovalEffectsService } from "../approval-resolution-effects-service.js";
import type { ServiceContext } from "../service-context.js";
import { ERRAND_APPROVAL_KIND, ERRAND_TOOL_NAME } from "./errand-approval-gate.js";

/**
 * An errand approval is answered while its Chat turn is still running the errand tool; the gate polls the approval
 * record itself. Waking the turn's durable run (or an approval wait run) for it would retry every few seconds while
 * the turn runs and could later resume an unrelated park, so no wake effect may be enqueued for this kind.
 */

const NOW = "2026-11-01T00:00:00.000Z";

function deps() {
  return {
    backgroundTasks: new Set<Promise<void>>(),
    wakeDurableRun: vi.fn(),
    requestRunProcessing: vi.fn(),
    findProactiveDurableRunIdsForApproval: vi.fn(() => []),
    executeCodeModePendingApproval: vi.fn(),
    executeApprovedPendingAction: vi.fn(),
    enqueueAfterHooks: vi.fn(),
    resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    recordApprovalResolutionSignals: vi.fn(),
  };
}

function seedRunningErrandTurn(storage: Storage, kind: string): ApprovalRequest {
  const sessionId = "session-errand";
  const turnId = "turn-errand";
  storage.chatTurnTraces.create({
    turnId,
    sessionId,
    userMessageId: "user-errand",
    assistantMessageId: "assistant-errand",
    status: "running",
    mode: "chat",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    routing: {},
    durable: { runId: "durable-errand-turn", status: "running" },
    startedAt: NOW,
  });
  const approval = storage.approvals.create({
    kind,
    riskLevel: "caution",
    payload: { category: "spend" },
    preview: { summary: "Click Place your order" },
    linkage: {
      sessionId,
      turnId,
      toolName: ERRAND_TOOL_NAME,
      actionType: "spend",
      originSurface: "chat",
    },
  });
  storage.chatInlineApprovals.upsert({
    approvalId: approval.approvalId,
    sessionId,
    turnId,
    kind,
    toolName: ERRAND_TOOL_NAME,
    status: "pending",
    reason: "Click Place your order",
    createdAt: NOW,
  });
  return storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
}

async function enqueuedKinds(kind: string): Promise<string[]> {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  try {
    const approval = seedRunningErrandTurn(storage, kind);
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      deps(),
    );
    const effects = await service.enqueueResolutionEffects(
      approval,
      { decision: "approve", resolvedBy: "operator" },
      { deferProcessing: true },
    );
    return effects.map((effect) => effect.effectKind);
  } finally {
    storage.close();
  }
}

describe("errand approval resolution effects", () => {
  it("control: a tool approval on the same running durable turn enqueues a linked Chat turn wake", async () => {
    expect(await enqueuedKinds("tool.invoke")).toContain("linked_chat_turn_wake");
  });

  it("enqueues no linked Chat turn wake for an errand approval", async () => {
    expect(await enqueuedKinds(ERRAND_APPROVAL_KIND)).not.toContain("linked_chat_turn_wake");
  });

  it("enqueues no approval-wait wake for an errand approval even when a wait run is reserved", async () => {
    const upsert = vi.fn(async (input: Record<string, unknown>) => ({ effectKind: input.effectKind }));
    const ctx = {
      storage: {
        approvalEffects: { upsert, listByApproval: vi.fn(async () => []) },
        approvalWaitRuns: { getRunId: vi.fn(async () => "approval-wait-1") },
        pendingApprovalActions: { find: vi.fn(async () => undefined) },
        approvalInbox: { findByApprovalAndToken: vi.fn(async () => undefined) },
        chatInlineApprovals: { get: vi.fn(async () => undefined) },
        chatTurnTraces: { get: vi.fn(async () => ({ sessionId: "session-errand", durable: { runId: "durable-1" } })) },
      },
      publishRealtime: vi.fn(),
    } as unknown as ServiceContext;
    const service = new ApprovalEffectsService(ctx, deps());
    const approval = {
      approvalId: "approval-errand",
      kind: ERRAND_APPROVAL_KIND,
      riskLevel: "caution",
      status: "approved",
      payload: {},
      preview: {},
      linkage: { sessionId: "session-errand", turnId: "turn-errand", toolName: ERRAND_TOOL_NAME },
      createdAt: NOW,
      resolvedAt: NOW,
      resolvedBy: "operator",
      explanationStatus: "not_requested",
    } satisfies ApprovalRequest;
    await service.enqueueResolutionEffects(
      approval,
      { decision: "approve", resolvedBy: "operator" },
      { deferProcessing: true },
    );
    const kinds = upsert.mock.calls.map(([input]) => input.effectKind);
    expect(kinds).toContain("approval_resolution_signals");
    expect(kinds).not.toContain("approval_wait_wake");
    expect(kinds).not.toContain("linked_chat_turn_wake");
  });
});
