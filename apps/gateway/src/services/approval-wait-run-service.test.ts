import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, DurableRunCreateRequest, DurableRunRecord } from "@goatcitadel/contracts";
import { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import type { ServiceContext } from "./service-context.js";

describe("ApprovalWaitRunService", () => {
  it("builds approval linkage from explicit linkage and request attribution", () => {
    const harness = createHarness({
      attribution: {
        correlationId: "corr-1",
        traceId: "trace-1",
        originSurface: "mission-control",
      },
    });

    const linkage = harness.service.buildApprovalLinkage({ sessionId: "session-1" });

    expect(linkage).toEqual({
      sessionId: "session-1",
      correlationId: "corr-1",
      traceId: "trace-1",
    });
  });

  it("creates and links a durable approval wait run outside GatewayService", () => {
    const harness = createHarness();
    const approval = createApproval();

    const run = harness.service.ensureApprovalWaitDurableRun(approval);

    expect(run?.runId).toBe("run-1");
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.createdRuns[0]).toMatchObject({
      workflowKey: "approval.wait",
      metadata: {
        approvalId: "approval-1",
        approvalKind: "shell.exec",
      },
      waitForEvent: {
        eventKey: "approval.resolved",
        correlationId: "approval-1",
      },
    });
    expect(harness.approvalWaitRuns.getRunId("approval-1")).toBe("run-1");
  });
});

function createHarness(
  options: {
    attribution?: { correlationId?: string; traceId?: string; originSurface?: string };
  } = {},
) {
  const createdRuns: DurableRunCreateRequest[] = [];
  const approvalWaitRuns = createApprovalWaitRunStore();
  const ctx = {
    storage: {
      approvalWaitRuns,
    },
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    publishRealtime: vi.fn(),
  } as unknown as ServiceContext;
  const service = new ApprovalWaitRunService(ctx, {
    createDurableRun: (input) => {
      createdRuns.push(input);
      return createDurableRunRecord(`run-${createdRuns.length}`);
    },
    getDurableRun: (runId) => createDurableRunRecord(runId),
    getRequestAttribution: () => options.attribution,
  });

  return {
    approvalWaitRuns,
    createdRuns,
    service,
  };
}

function createApprovalWaitRunStore() {
  const rows = new Map<string, { approvalId: string; runId: string; createdAt: string; resolvedAt?: string }>();
  return {
    get: (approvalId: string) => rows.get(approvalId),
    getRunId: (approvalId: string) => rows.get(approvalId)?.runId,
    upsert: (input: { approvalId: string; runId: string; createdAt?: string; resolvedAt?: string | null }) => {
      const row = {
        approvalId: input.approvalId,
        runId: input.runId,
        createdAt: input.createdAt ?? "2026-04-10T11:00:00.000Z",
        resolvedAt: input.resolvedAt ?? undefined,
      };
      rows.set(input.approvalId, row);
      return row;
    },
    markResolved: (approvalId: string, resolvedAt?: string) => {
      const current = rows.get(approvalId);
      if (!current) {
        return undefined;
      }
      const next = {
        ...current,
        resolvedAt: resolvedAt ?? "2026-04-10T11:30:00.000Z",
      };
      rows.set(approvalId, next);
      return next;
    },
  };
}

function createApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "shell.exec",
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: {},
    createdAt: "2026-04-10T10:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

function createDurableRunRecord(runId: string): DurableRunRecord {
  return {
    runId,
    workflowKey: "approval.wait",
    status: "waiting",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {},
    metadata: {},
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-10T10:00:00.000Z",
  } as DurableRunRecord;
}
