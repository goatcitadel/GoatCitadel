import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type ApprovalRequest,
  type DurableRunCreateRequest,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import type { ServiceContext } from "./service-context.js";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";

describe("ApprovalWaitRunService", () => {
  describe.each(["remote_worker.native_runtime", "remote_worker.native_runtime_install"])("%s parent-preserving waits", kind => {
  const nativeApproval = () => createApproval({ kind,
    linkage: { durableRunId: "parent-run", actionType: kind } });

  it("retains two native reviews across service restart under the real unique wait-run constraint", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const parent = storage.durableRuns.createRun({ runId: "parent-run", workflowKey: "chat.turn", status: "running" });
      const asyncStorage = createSqliteAsyncStorage(storage);
      const createDurableRun = vi.fn(async (input: DurableRunCreateRequest) => storage.durableRuns.createRun({ ...input,
        status: "waiting", metadata: { ...input.metadata, waitForEvent: input.waitForEvent } }));
      const service = () => new ApprovalWaitRunService({ storage: asyncStorage,
        isFeatureEnabled: async () => true, publishRealtime: async () => undefined },
      { createDurableRun, getDurableRun: async runId => storage.durableRuns.getRun(runId) });
      const ids: string[] = [];
      for (const approvalId of ["native-review-1", "native-review-2"]) {
        const { kind, riskLevel, payload, preview, linkage } = nativeApproval();
        const { approval } = storage.approvals.createDeterministicDetachedWithTtlDuration({
          kind, riskLevel, payload, preview, linkage, approvalId }, 60_000);
        const primed = await service().primeApprovalLifecycle(approvalId);
        expect(primed.linkage).toEqual(approval.linkage);
        const waitId = storage.approvalWaitRuns.getRunId(approvalId)!;
        expect(waitId).not.toBe(parent.runId);
        ids.push(waitId);
        expect((await service().ensureApprovalWaitDurableRun(approval))?.payload.approvalId).toBe(approvalId);
      }
      expect(new Set(ids).size).toBe(2);
      expect(createDurableRun).toHaveBeenCalledTimes(2);
      expect(storage.durableRuns.getRun(parent.runId)).toEqual(parent);
    } finally { storage.close(); }
  });

  it("creates distinct native review waits while preserving their shared execution parent", async () => {
    const parent = { ...createDurableRunRecord("parent-run"), workflowKey: "chat.turn" };
    const harness = createHarness({ existingRun: parent });
    const approval = nativeApproval();
    expect(await harness.service.reserveApprovalWaitRun(approval)).toBe(approval);
    const first = await harness.service.ensureApprovalWaitDurableRun(approval);
    const secondApproval = { ...nativeApproval(), approvalId: "approval-2" };
    const second = await harness.service.ensureApprovalWaitDurableRun(secondApproval);
    expect(first?.runId).not.toBe(parent.runId);
    expect(second?.runId).not.toBe(first?.runId);
    expect(first?.payload.approvalId).toBe(approval.approvalId);
    expect(second?.payload.approvalId).toBe(secondApproval.approvalId);
    expect((await harness.service.ensureApprovalWaitDurableRun(approval))?.runId).toBe(first?.runId);
    expect(approval.linkage?.durableRunId).toBe(parent.runId);
    expect(secondApproval.linkage?.durableRunId).toBe(parent.runId);
    expect(harness.createdRuns).toHaveLength(2);
  });

  it.each(["missing", "wrong_identity", "approval_wait", "missing_link", "wrong_action"])(
    "does not reserve or create a replacement native parent when %s", async mode => {
      const parent = { ...createDurableRunRecord(mode === "wrong_identity" ? "other" : "parent-run"),
        workflowKey: mode === "approval_wait" ? "approval.wait" : "chat.turn" };
      const harness = createHarness({ existingRun: mode === "missing" ? undefined : parent });
      const approval = nativeApproval();
      if (mode === "missing_link") delete approval.linkage!.durableRunId;
      if (mode === "wrong_action") approval.linkage!.actionType = "tool.invoke";
      await expect(harness.service.reserveApprovalWaitRun(approval)).rejects.toThrow();
      expect(harness.approvalWaitRuns.getRunId(approval.approvalId)).toBeUndefined();
      expect(harness.createdRuns).toEqual([]);
    });

  it("does not fabricate a vanished native parent during deferred materialization", async () => {
    const harness = createHarness();
    harness.approvalWaitRuns.createOrGet({ approvalId: "approval-1", runId: "parent-run" });
    await expect(harness.service.ensureApprovalWaitDurableRun(nativeApproval())).rejects.toThrow();
    expect(harness.createdRuns).toEqual([]);
  });

  it("refuses a legacy parent-as-wait reservation without relinking the approval", async () => {
    const harness = createHarness({ existingRun: { ...createDurableRunRecord("parent-run"), workflowKey: "chat.turn" } });
    harness.approvalWaitRuns.createOrGet({ approvalId: "approval-1", runId: "parent-run" });
    const approval = nativeApproval();
    await expect(harness.service.reserveApprovalWaitRun(approval)).rejects.toThrow("separate wait run");
    await expect(harness.service.ensureApprovalWaitDurableRun(approval)).rejects.toThrow("separate wait run");
    expect(approval.linkage?.durableRunId).toBe("parent-run");
    expect(harness.createdRuns).toEqual([]);
  });

  });

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

  it("builds realtime links from canonical approval linkage", () => {
    const harness = createHarness();

    const links = harness.service.buildApprovalRealtimeLinks(
      createApproval({
        linkage: {
          sessionId: "session-1",
          taskId: "task-1",
          durableRunId: "run-42",
          proactiveRunId: "proactive-1",
          workspaceId: "workspace-1",
          connectorId: "connector-1",
          tokenId: "token-1",
        },
      }),
    );

    expect(links).toEqual({
      approvalId: "approval-1",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-42",
      proactiveRunId: "proactive-1",
      workspaceId: "workspace-1",
      connectorId: "connector-1",
      tokenId: "token-1",
    });
  });

  it("creates and links a durable approval wait run outside GatewayService", async () => {
    const harness = createHarness();
    const approval = createApproval();

    const run = await harness.service.ensureApprovalWaitDurableRun(approval);

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

  it("creates the durable run with the transactionally reserved run id", async () => {
    const harness = createHarness();
    const reserved = await harness.service.reserveApprovalWaitRun(createApproval());

    const run = await harness.service.ensureApprovalWaitDurableRun(reserved);

    expect(reserved.linkage?.durableRunId).toBeTruthy();
    expect(run?.runId).toBe(reserved.linkage?.durableRunId);
    expect(harness.createdRuns[0]).toMatchObject({ runId: reserved.linkage?.durableRunId });
  });

  it("primes approval lifecycle by attaching linkage and durable run id", async () => {
    const harness = createHarness({
      attribution: {
        correlationId: "corr-2",
        traceId: "trace-2",
      },
    });

    const approval = await harness.service.primeApprovalLifecycle("approval-1", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(approval.linkage).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      durableRunId: "run-1",
    });
    expect(harness.approvalWaitRuns.getRunId("approval-1")).toBe("run-1");
  });
});

function createHarness(
  options: {
    attribution?: { correlationId?: string; traceId?: string; originSurface?: string };
    existingRun?: DurableRunRecord;
  } = {},
) {
  const createdRuns: DurableRunCreateRequest[] = [];
  let nextWaitId = 0;
  const approvalWaitRuns = createApprovalWaitRunStore();
  const approvals = createApprovalsStore([createApproval()]);
  const ctx = {
    storage: {
      approvals,
      approvalWaitRuns,
    },
    isFeatureEnabled: vi.fn(async (flag: string) => flag === "durableKernelV1Enabled"),
    publishRealtime: vi.fn(async () => undefined),
  } as unknown as ServiceContext;
  const service = new ApprovalWaitRunService(ctx, {
    createDurableRun: async (input) => {
      createdRuns.push(input);
      return { ...createDurableRunRecord(input.runId ?? `run-${createdRuns.length}`), payload: input.payload };
    },
    getDurableRun: async (runId) => {
      if (options.existingRun && runId === "parent-run") return options.existingRun;
      const created = createdRuns.find((input) => input.runId === runId);
      if (!created) {
        throw new NotFoundError({ entity: "Durable run", id: runId });
      }
      return { ...createDurableRunRecord(runId), payload: created.payload };
    },
    getRequestAttribution: () => options.attribution,
    createApprovalWaitRunId: () => `run-${++nextWaitId}`,
  });

  return {
    approvals,
    approvalWaitRuns,
    createdRuns,
    service,
  };
}

function createApprovalsStore(initial: ApprovalRequest[]) {
  const rows = new Map(initial.map((approval) => [approval.approvalId, approval]));
  return {
    get: (approvalId: string) => {
      const approval = rows.get(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      return approval;
    },
    mergeLinkage: (approvalId: string, linkage: NonNullable<ApprovalRequest["linkage"]>) => {
      const current = rows.get(approvalId);
      if (!current) {
        throw new Error(`Unknown approval ${approvalId}`);
      }
      const next = {
        ...current,
        linkage: {
          ...(current.linkage ?? {}),
          ...linkage,
        },
      };
      rows.set(approvalId, next);
      return next;
    },
  };
}

function createApprovalWaitRunStore() {
  const rows = new Map<string, { approvalId: string; runId: string; createdAt: string; resolvedAt?: string }>();
  return {
    get: (approvalId: string) => rows.get(approvalId),
    getRunId: (approvalId: string) => rows.get(approvalId)?.runId,
    createOrGet: (input: { approvalId: string; runId: string; createdAt?: string }) => {
      const existing = rows.get(input.approvalId);
      if (existing) {
        return existing;
      }
      const row = {
        approvalId: input.approvalId,
        runId: input.runId,
        createdAt: input.createdAt ?? "2026-04-10T11:00:00.000Z",
      };
      rows.set(input.approvalId, row);
      return row;
    },
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
